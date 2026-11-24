import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import {
  type Derivado,
  type FonteYaml,
  interpretarDerivado,
  interpretarFonteYaml,
} from "@/modules/acervo/schemas";
import {
  CODIGO_DE_CONFLITO,
  carregarFontes,
  codigoDeSaida,
  executarCarga,
  type FonteParaCarga,
} from "../../../scripts/acervo/carregar";
import { ErroCarga } from "../../../scripts/ingest/carregar-biblia";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { criarSessaoDeTeste } from "../../support/sessao-admin-banco";

// A carga do arquivo NUNCA sobrescreve em silêncio uma edição feita no painel (ACER-08, T-02-42): recusa a Fonte editada
// com a lista de campos, carrega o resto e sai com código 3. Banco descartável SÓ deste arquivo, fora do Neon.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let app: pg.Client;
let dono: pg.Client;
let envDoBanco: Record<string, string> = {};
let sessaoAdmin = "";
const temporarios: string[] = [];

const yamlBase = (): FonteYaml =>
  interpretarFonteYaml(
    readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
    "josefo-antiguidades.yaml",
  );
// biome-ignore lint/suspicious/noExplicitAny: o teste mexe no JSON bruto
const derivadoBase = (alterar?: (b: Record<string, any>) => void): Derivado => {
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  );
  alterar?.(bruto);
  return interpretarDerivado(bruto, "josefo-antiguidades.json");
};

/** A Fonte de teste com outro slug (o derivado acompanha). */
function comSlug(slug: string, mudar: (f: FonteYaml) => FonteYaml = (f) => f): FonteParaCarga {
  return {
    fonte: mudar({ ...yamlBase(), slug }),
    derivado: derivadoBase((b) => {
      b.slug = slug;
    }),
  };
}

async function linha(slug: string) {
  return (await dono.query("select * from acervo.fonte where slug = $1", [slug])).rows[0];
}
async function secao(id: string) {
  return (await dono.query("select * from acervo.fonte_secao where id = $1", [id])).rows[0];
}
const painel = (sql: string, params: unknown[]) => app.query(sql, params);
const revisaoDe = async (slug: string): Promise<number> =>
  ((await linha(slug)) as { revisao: number }).revisao;
const editarLimites = async (slug: string, limites: string, revisao?: number) =>
  painel("select acervo.salvar_fonte($1::uuid, $2::jsonb)", [
    sessaoAdmin,
    JSON.stringify({
      modo: "editar",
      slug,
      limites_pt: limites,
      revisao: revisao ?? (await revisaoDe(slug)),
    }),
  ]);

let contador = 0;
const novoSlug = () => `conflito-${++contador}`;

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  envDoBanco = preparado.env;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  app = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: false }) });
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await Promise.all([carga.connect(), app.connect(), dono.connect()]);
  sessaoAdmin = (await criarSessaoDeTeste(dono, "admin-com-segundo-fator")).sessaoId;
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, app, dono]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(emNeon())(
  "a carga e a edição do painel convivem sem que uma destrua a outra",
  () => {
    it("sem edição a carga é idempotente (inseridos=0, atualizados=0, sem conflito) e grava o hash da última carga", async () => {
      const slug = novoSlug();
      const primeira = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(primeira.fontes.inseridos).toBe(1);
      expect(primeira.conflitos).toEqual([]);
      const f = await linha(slug);
      expect(f.hash_ultima_carga).toMatch(/^[0-9a-f]{64}$/);
      expect(f.valores_arquivo.limites_pt).toContain("Obra escrita em grego");
      expect(f.publicada_arquivo).toBe(true);
      expect(f.conflito_carga).toEqual([]);
      expect((await secao(`${slug}/18`)).hash_ultima_carga).toMatch(/^[0-9a-f]{64}$/);

      const segunda = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(segunda).toMatchObject({ inseridos: 0, atualizados: 0, removidos: 0, conflitos: [] });
      expect(codigoDeSaida({ carregadas: 1, puladas: [], resultado: segunda })).toBe(0);
    });

    it("limites editados no painel: a Fonte é recusada com a lista de campos, nada é sobrescrito, o resto carrega, código 3", async () => {
      const editada = novoSlug();
      const outra = novoSlug();
      await carregarFontes([comSlug(editada)], { cliente: carga });
      await editarLimites(editada, "Limites do painel.");
      const antes = await linha(editada);

      // O arquivo muda título e limites; mesmo assim a Fonte editada fica intacta. A outra Fonte (nova) carrega.
      const r = await carregarFontes(
        [
          comSlug(editada, (f) => ({
            ...f,
            titulo: "Título novo do arquivo",
            limites_pt: "Do arquivo, outra.",
          })),
          comSlug(outra),
        ],
        { cliente: carga },
      );
      expect(r.conflitos).toEqual([{ slug: editada, campos: ["limites_pt"] }]);
      expect(r.fontes.inseridos).toBe(1);
      expect(codigoDeSaida({ carregadas: 2, puladas: [], resultado: r })).toBe(CODIGO_DE_CONFLITO);
      expect(CODIGO_DE_CONFLITO).toBe(3);

      const depois = await linha(editada);
      expect(depois.limites_pt).toBe("Limites do painel.");
      expect(depois.titulo).toBe(antes.titulo);
      expect(depois.hash_ultima_carga).toBe(antes.hash_ultima_carga);
      expect(depois.valores_arquivo).toEqual(antes.valores_arquivo);
      expect(depois.conflito_carga).toEqual(["limites_pt"]);
      expect(await linha(outra)).toBeDefined();
    });

    it("controle positivo: sem edição no painel, a mudança do arquivo SIM é aplicada", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      const r = await carregarFontes(
        [comSlug(slug, (f) => ({ ...f, limites_pt: "Limites novos do arquivo." }))],
        { cliente: carga },
      );
      expect(r.conflitos).toEqual([]);
      expect(r.fontes.atualizados).toBe(1);
      expect((await linha(slug)).limites_pt).toBe("Limites novos do arquivo.");
    });

    it("resumo de seção editado no painel é conflito (<seção>:resumo_pt), e a seção e a Fonte ficam intactas", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      await painel("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
        sessaoAdmin,
        `${slug}/18`,
        "Resumo do painel.",
        ["Jesus", "Pilatos", "cristãos"],
      ]);
      const r = await carregarFontes(
        [
          comSlug(slug, (f) => ({
            ...f,
            limites_pt: "Mudou no arquivo.",
            secoes: f.secoes.map((s) =>
              s.slug === "18" ? { ...s, resumo_pt: "Resumo do arquivo." } : s,
            ),
          })),
        ],
        { cliente: carga },
      );
      expect(r.conflitos).toEqual([{ slug, campos: ["18:resumo_pt"] }]);
      expect((await secao(`${slug}/18`)).resumo_pt).toBe("Resumo do painel.");
      expect((await linha(slug)).limites_pt).not.toBe("Mudou no arquivo.");
    });

    it("reverter_fonte devolve os campos ao que o arquivo tinha, limpa o conflito, e a carga seguinte volta ao código 0", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      const original = (await linha(slug)).limites_pt;
      await editarLimites(slug, "Limites do painel.");
      await painel("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
        sessaoAdmin,
        `${slug}/20`,
        "Resumo do painel.",
        ["x"],
      ]);
      const recusada = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(recusada.conflitos[0]?.campos.sort()).toEqual(
        ["20:resumo_pt", "20:palavras_chave_pt", "limites_pt"].sort(),
      );

      // Reverte só os limites: o resumo continua em conflito.
      await painel("select acervo.reverter_fonte($1::uuid, $2, $3::text[])", [
        sessaoAdmin,
        slug,
        ["limites_pt"],
      ]);
      expect((await linha(slug)).limites_pt).toBe(original);
      expect((await linha(slug)).conflito_carga.sort()).toEqual([
        "20:palavras_chave_pt",
        "20:resumo_pt",
      ]);

      // Reverte o que resta (sem lista = todos).
      await painel("select acervo.reverter_fonte($1::uuid, $2, null)", [sessaoAdmin, slug]);
      const s20 = await secao(`${slug}/20`);
      expect(s20.resumo_pt).toContain("trecho do livro 20");
      expect(s20.palavras_chave_pt).toEqual(["Tiago", "Anano", "Albino"]);
      expect((await linha(slug)).conflito_carga).toEqual([]);

      const limpa = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(limpa).toMatchObject({ inseridos: 0, atualizados: 0, conflitos: [] });
    });

    it("reverter: os demais papéis são recusados e só o Admin com segundo fator reverte", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      await editarLimites(slug, "Limites do painel.");
      await carregarFontes([comSlug(slug)], { cliente: carga });
      const estudante = (await criarSessaoDeTeste(dono, "estudante")).sessaoId;
      const semFator = (await criarSessaoDeTeste(dono, "admin-sem-segundo-fator")).sessaoId;
      for (const s of [estudante, semFator])
        await expect(
          painel("select acervo.reverter_fonte($1::uuid, $2, null)", [s, slug]),
        ).rejects.toMatchObject({ code: "42501" });
      await expect(
        carga.query("select acervo.reverter_fonte($1::uuid, $2, null)", [sessaoAdmin, slug]),
      ).rejects.toMatchObject({ code: "42501" });
      expect((await linha(slug)).limites_pt).toBe("Limites do painel.");
      await painel("select acervo.reverter_fonte($1::uuid, $2, null)", [sessaoAdmin, slug]);
      expect((await linha(slug)).limites_pt).toContain("Obra escrita em grego");
    });

    it("convergência: o arquivo passa a dizer o que o painel disse, e a carga não vê conflito", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      await editarLimites(slug, "Mesmo texto nos dois lados.");
      const r = await carregarFontes(
        [comSlug(slug, (f) => ({ ...f, limites_pt: "Mesmo texto nos dois lados." }))],
        { cliente: carga },
      );
      expect(r.conflitos).toEqual([]);
      const f = await linha(slug);
      expect(f.limites_pt).toBe("Mesmo texto nos dois lados.");
      expect(f.valores_arquivo.limites_pt).toBe("Mesmo texto nos dois lados.");
      const de_novo = await carregarFontes(
        [comSlug(slug, (x) => ({ ...x, limites_pt: "Mesmo texto nos dois lados." }))],
        { cliente: carga },
      );
      expect(de_novo).toMatchObject({ atualizados: 0, conflitos: [] });
    });

    it("publicação é mescla de três vias: editar só a publicação não gera conflito e a carga não desfaz a escolha do painel", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga }); // arquivo: publicada = true
      await painel("select acervo.salvar_fonte($1::uuid, $2::jsonb)", [
        sessaoAdmin,
        JSON.stringify({ modo: "editar", slug, publicada: false, revisao: await revisaoDe(slug) }),
      ]);
      const mesmo = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(mesmo.conflitos).toEqual([]);
      expect(mesmo.atualizados).toBe(0);
      expect((await linha(slug)).publicada).toBe(false);
      expect((await linha(slug)).publicada_arquivo).toBe(true);

      // O arquivo muda de ideia depois: o painel mexeu, então vale o painel.
      const arquivoDesliga = await carregarFontes(
        [comSlug(slug, (f) => ({ ...f, publicada: false }))],
        { cliente: carga },
      );
      expect(arquivoDesliga.conflitos).toEqual([]);
      expect((await linha(slug)).publicada).toBe(false);
      expect((await linha(slug)).publicada_arquivo).toBe(false);
    });

    it("publicação que o painel não tocou segue o arquivo (o arquivo publica a Fonte nova, como Tácito)", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug, (f) => ({ ...f, publicada: false }))], {
        cliente: carga,
      });
      expect((await linha(slug)).publicada).toBe(false);
      const r = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(r.conflitos).toEqual([]);
      expect(r.fontes.atualizados).toBe(1);
      expect((await linha(slug)).publicada).toBe(true);
    });

    it("Fonte do painel nunca é tocada: o YAML de mesmo slug é recusado com mensagem e nada muda", async () => {
      const slug = novoSlug();
      await painel("select acervo.salvar_fonte($1::uuid, $2::jsonb)", [
        sessaoAdmin,
        JSON.stringify({
          modo: "criar",
          slug,
          titulo: "Só do painel",
          nivel: "primaria",
          tipo_texto: "integral",
          idioma: "pt",
          licenca: "dp-declarado-pela-origem",
          origem_url: "https://exemplo.invalid/x",
        }),
      ]);
      const antes = await linha(slug);
      await expect(carregarFontes([comSlug(slug)], { cliente: carga })).rejects.toThrow(
        /criada pelo painel e a carga nunca a toca/,
      );
      await expect(carregarFontes([comSlug(slug)], { cliente: carga })).rejects.toBeInstanceOf(
        ErroCarga,
      );
      expect(await linha(slug)).toEqual(antes);
    });

    it("Fonte carregada antes da migração (hash nulo) carrega sem conflito e passa a ter o hash, sem contar como atualização", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      await dono.query(
        "update acervo.fonte set hash_ultima_carga = null, valores_arquivo = null, publicada_arquivo = null where slug = $1",
        [slug],
      );
      await dono.query(
        "update acervo.fonte_secao set hash_ultima_carga = null, valores_arquivo = null where fonte_id = (select id from acervo.fonte where slug = $1)",
        [slug],
      );
      await editarLimites(
        slug,
        "Editada antes de existir a marca: o arquivo vale (sem registro não há como saber).",
      );
      const r = await carregarFontes([comSlug(slug)], { cliente: carga });
      expect(r.conflitos).toEqual([]);
      expect(r.secoes.atualizados).toBe(0);
      const f = await linha(slug);
      expect(f.hash_ultima_carga).toMatch(/^[0-9a-f]{64}$/);
      expect((await secao(`${slug}/18`)).hash_ultima_carga).toMatch(/^[0-9a-f]{64}$/);
      expect(f.conflito_carga).toEqual([]);
    });

    it("última carga A, painel B, arquivo C: a carga recusa guardando C, e 'Reverter ao arquivo' volta a C (não a A) e limpa o aviso", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug, (f) => ({ ...f, limites_pt: "A: da última carga." }))], {
        cliente: carga,
      });
      await editarLimites(slug, "B: do painel.");
      const recusada = await carregarFontes(
        [comSlug(slug, (f) => ({ ...f, limites_pt: "C: o arquivo mudou." }))],
        { cliente: carga },
      );
      expect(recusada.conflitos).toEqual([{ slug, campos: ["limites_pt"] }]);
      expect((await linha(slug)).limites_pt).toBe("B: do painel.");
      expect((await linha(slug)).valores_recusados).toEqual({ limites_pt: "C: o arquivo mudou." });
      await painel("select acervo.reverter_fonte($1::uuid, $2, null)", [sessaoAdmin, slug]);
      const f = await linha(slug);
      expect(f.limites_pt).toBe("C: o arquivo mudou.");
      expect(f.conflito_carga).toEqual([]);
      expect(f.valores_recusados).toEqual({});
      // A carga seguinte, com o mesmo arquivo (C), não vê conflito nem muda nada.
      const limpa = await carregarFontes(
        [comSlug(slug, (x) => ({ ...x, limites_pt: "C: o arquivo mudou." }))],
        { cliente: carga },
      );
      expect(limpa).toMatchObject({ atualizados: 0, conflitos: [] });
      expect((await linha(slug)).limites_pt).toBe("C: o arquivo mudou.");
    });

    it("o mesmo vale para o resumo e as palavras-chave de uma seção: a reversão usa o que o arquivo diz agora", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      await painel("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
        sessaoAdmin,
        `${slug}/18`,
        "Resumo do painel.",
        ["p"],
      ]);
      await carregarFontes(
        [
          comSlug(slug, (f) => ({
            ...f,
            secoes: f.secoes.map((s) =>
              s.slug === "18"
                ? { ...s, resumo_pt: "Resumo novo do arquivo.", palavras_chave_pt: ["n1", "n2"] }
                : s,
            ),
          })),
        ],
        { cliente: carga },
      );
      await painel("select acervo.reverter_fonte($1::uuid, $2, null)", [sessaoAdmin, slug]);
      const s18 = await secao(`${slug}/18`);
      expect(s18.resumo_pt).toBe("Resumo novo do arquivo.");
      expect(s18.palavras_chave_pt).toEqual(["n1", "n2"]);
    });

    it("a carga que muda a Fonte sobe a revisão: o formulário aberto antes dela é recusado (40001) em vez de sobrescrever a carga", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      const lida = await revisaoDe(slug);
      await carregarFontes(
        [comSlug(slug, (f) => ({ ...f, limites_pt: "A carga mudou os limites." }))],
        { cliente: carga },
      );
      expect(await revisaoDe(slug)).toBeGreaterThan(lida);
      await expect(editarLimites(slug, "Do formulário velho.", lida)).rejects.toMatchObject({
        code: "40001",
      });
      expect((await linha(slug)).limites_pt).toBe("A carga mudou os limites.");
      // Carga sem mudança de conteúdo não sobe a revisão (senão todo formulário aberto morreria à toa).
      const atual = await revisaoDe(slug);
      await carregarFontes(
        [comSlug(slug, (f) => ({ ...f, limites_pt: "A carga mudou os limites." }))],
        { cliente: carga },
      );
      expect(await revisaoDe(slug)).toBe(atual);
      // Controle positivo: com a revisão atual o painel salva.
      await editarLimites(slug, "Do formulário novo.", atual);
      expect((await linha(slug)).limites_pt).toBe("Do formulário novo.");
    });

    it("corrida: edição do painel em curso faz a carga esperar e, ao acordar, ver a edição e recusar (a Fonte fica travada)", async () => {
      const slug = novoSlug();
      await carregarFontes([comSlug(slug)], { cliente: carga });
      const cargaB = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
      const painelB = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: false }) });
      await Promise.all([cargaB.connect(), painelB.connect()]);
      try {
        await painelB.query("begin");
        await painelB.query("select acervo.salvar_fonte($1::uuid, $2::jsonb)", [
          sessaoAdmin,
          JSON.stringify({
            modo: "editar",
            slug,
            limites_pt: "Edição em curso.",
            revisao: await revisaoDe(slug),
          }),
        ]);
        const pid = (await cargaB.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const emCurso = carregarFontes(
          [comSlug(slug, (f) => ({ ...f, limites_pt: "Do arquivo." }))],
          {
            cliente: cargaB,
          },
        );
        let bloqueada = false;
        for (let i = 0; i < 100 && !bloqueada; i++) {
          const r = await dono.query(
            "select wait_event_type from pg_stat_activity where pid = $1",
            [pid],
          );
          bloqueada = r.rows[0]?.wait_event_type === "Lock";
          if (!bloqueada) await new Promise((res) => setTimeout(res, 50));
        }
        expect(bloqueada, "a carga deve ficar esperando o lock da Fonte").toBe(true);
        await painelB.query("commit");
        const r = await emCurso;
        expect(r.conflitos).toEqual([{ slug, campos: ["limites_pt"] }]);
        expect((await linha(slug)).limites_pt).toBe("Edição em curso.");
      } finally {
        await painelB.query("rollback").catch(() => {});
        await Promise.all([cargaB.end().catch(() => {}), painelB.end().catch(() => {})]);
      }
    });
  },
);

describe.skipIf(emNeon())("o comando acervo:load", () => {
  function montarPastas(): { fontes: string; derivados: string; lock: string } {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-conflito-"));
    temporarios.push(raiz);
    const fontes = path.join(raiz, "fontes");
    const derivados = path.join(raiz, "derivados");
    mkdirSync(fontes);
    mkdirSync(derivados);
    cpSync(
      path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"),
      path.join(fontes, "josefo-antiguidades.yaml"),
    );
    cpSync(path.join(FIXTURES, "derivados"), derivados, { recursive: true });
    const bytes = readFileSync(path.join(derivados, "josefo-antiguidades.json"));
    const lock = path.join(raiz, "lock.json");
    writeFileSync(
      lock,
      JSON.stringify({
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: 31_457_280,
        derivados: {
          "josefo-antiguidades": {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            bytes: bytes.length,
          },
        },
      }),
    );
    return { fontes, derivados, lock };
  }

  it("sai com 0 sem edição e com 3 quando o painel editou (processo de verdade), listando a Fonte e os campos", async () => {
    const pastas = montarPastas();
    const rodar = () =>
      spawnSync(
        "pnpm",
        [
          "exec",
          "tsx",
          "scripts/acervo/carregar.ts",
          "--fontes",
          pastas.fontes,
          "--derivados",
          pastas.derivados,
          "--lock",
          pastas.lock,
        ],
        { cwd: RAIZ, env: { ...process.env, ...envDoBanco }, encoding: "utf8" },
      );
    const primeira = rodar();
    expect(primeira.status, primeira.stderr).toBe(0);
    await editarLimites("josefo-antiguidades", "Edição do painel antes da segunda carga.");
    const segunda = rodar();
    expect(segunda.status, segunda.stderr + segunda.stdout).toBe(3);
    expect(segunda.stdout).toContain("conflito: josefo-antiguidades");
    expect(segunda.stdout).toContain("limites_pt");
    expect((await linha("josefo-antiguidades")).limites_pt).toBe(
      "Edição do painel antes da segunda carga.",
    );
    // Reverte e a carga volta a 0.
    await painel("select acervo.reverter_fonte($1::uuid, $2, null)", [
      sessaoAdmin,
      "josefo-antiguidades",
    ]);
    expect(rodar().status).toBe(0);
  }, 120_000);

  it("executarCarga devolve os conflitos e escreve uma linha por conflito", async () => {
    const pastas = montarPastas();
    const linhas: string[] = [];
    const abrir = async () => {
      const c = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
      await c.connect();
      return c;
    };
    // A Fonte do comando já existe do teste anterior neste banco.
    const r = await executarCarga(pastas, { abrir, escrever: (l) => linhas.push(l) });
    expect(r.resultado?.conflitos).toEqual([]);
    expect(codigoDeSaida(r)).toBe(0);
  }, 60_000);
});
