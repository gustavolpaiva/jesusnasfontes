import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { parse, stringify } from "yaml";
import { obterPool } from "@/db/cliente";
import {
  type Derivado,
  type FonteYaml,
  interpretarDerivado,
  interpretarFonteYaml,
} from "@/modules/acervo/schemas";
import {
  carregarFontes,
  codigoDeSaida,
  executarCarga,
  type FonteParaCarga,
  TETO_DE_UNIDADES_POR_FONTE,
} from "../../../scripts/acervo/carregar";
import { linhasDeConflito } from "../../../scripts/db/build-producao";
import { ErroCarga } from "../../../scripts/ingest/carregar-biblia";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// O build de produção nunca apaga e nunca leva o conteúdo para trás (plano 02-22, revisão cruzada do Codex, CRÍTICA):
// um build de uma versão ANTERIOR (redeploy ou rollback na Vercel) carregava o derivado velho por cima do banco novo e
// apagava o que ele não tinha. Aqui: (a) derivado mais velho sobre banco mais novo não apaga nem sobrescreve, e avisa;
// (b) nada é apagado mesmo quando o derivado não tem uma seção; (c) outra Fonte fica intacta; (d) o teto aborta sem
// escrever. Banco descartável SÓ deste arquivo; não roda no Neon.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let dono: pg.Client;
const temporarios: string[] = [];

const SHA = (c: string) => c.repeat(64);

function fonteDaFixture(slug = "josefo-antiguidades", soSecao18 = false): FonteYaml {
  const y = interpretarFonteYaml(
    readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
    "josefo-antiguidades.yaml",
  );
  return { ...y, slug, secoes: soSecao18 ? y.secoes.filter((s) => s.slug === "18") : y.secoes };
}
// biome-ignore lint/suspicious/noExplicitAny: o teste mexe no JSON bruto para fabricar derivados
function derivadoDaFixture(slug = "josefo-antiguidades", alterar?: (b: any) => void): Derivado {
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  );
  bruto.slug = slug;
  alterar?.(bruto);
  return interpretarDerivado(bruto, `${slug}.json`);
}
const item = (
  revisao: number,
  sha: string,
  opcoes: { slug?: string; soSecao18?: boolean; alterar?: (b: never) => void } = {},
): FonteParaCarga => ({
  fonte: fonteDaFixture(opcoes.slug, opcoes.soSecao18),
  derivado: derivadoDaFixture(opcoes.slug, opcoes.alterar as never),
  versao: { revisao, sha256: SHA(sha) },
});
// Derivado "novo": o texto de 18.63 revisado e um parágrafo a mais (18.65), que um derivado velho não tem.
const novo = (b: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) => {
  const p0 = b.secoes[0]?.paragrafos[0] as { texto: string };
  p0.texto = `${p0.texto} (texto novo da revisão 2)`;
  b.secoes[0]?.paragrafos.push({
    ref: "18.65",
    texto: "Parágrafo que só existe no derivado novo.",
  });
};

async function linhas(sql: string, params: unknown[] = []) {
  return (await dono.query(sql, params)).rows;
}
const contar = async (sql: string, params: unknown[] = []) =>
  Number((await linhas(sql, params))[0]?.n ?? -1);
/** Fotografia do conteúdo de uma Fonte: se algo foi escrito ou apagado, ela muda. */
const foto = async (slug: string) =>
  JSON.stringify([
    await linhas(
      "select id, ordem, titulo, resumo_pt from acervo.fonte_secao where fonte_id = (select id from acervo.fonte where slug = $1) order by id",
      [slug],
    ),
    await linhas(
      `select p.id, p.secao_id, p.ordem, p.texto from acervo.fonte_paragrafo p
         join acervo.fonte_secao s on s.id = p.secao_id join acervo.fonte f on f.id = s.fonte_id
        where f.slug = $1 order by p.id`,
      [slug],
    ),
    await linhas(
      "select titulo, publicada, revisao, derivado_revisao, derivado_sha256 from acervo.fonte where slug = $1",
      [slug],
    ),
  ]);
const apagarTudo = async () => {
  await dono.query("delete from acervo.fonte_paragrafo");
  await dono.query("delete from acervo.fonte_secao");
  await dono.query("delete from acervo.fonte");
};

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await dono.connect();
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(emNeon())("a carga nunca leva o conteúdo para trás nem apaga sozinha", () => {
  it("registra de qual revisão do derivado a Fonte foi carregada", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const [f] = await linhas(
      "select derivado_revisao, derivado_sha256 from acervo.fonte where slug = 'josefo-antiguidades'",
    );
    expect(f).toEqual({ derivado_revisao: 1, derivado_sha256: SHA("a") });
  });

  it("(a) derivado MAIS VELHO sobre banco MAIS NOVO: nada é apagado, nada é sobrescrito, e avisa", async () => {
    await apagarTudo();
    // O banco tem a revisão 2 (texto revisado e o parágrafo 18.65)...
    await carregarFontes([item(2, "b", { alterar: novo as never })], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(3);

    // ...e um build de uma versão anterior traz a revisão 1, sem o 18.65 e com o texto velho.
    const r = await carregarFontes([item(1, "a")], { cliente: carga });
    // O que importa primeiro: o banco. Nada apagado (o 18.65 continua), nada sobrescrito (o texto novo continua).
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(3);
    const [p] = await linhas(
      "select texto from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.63'",
    );
    expect(p?.texto).toContain("(texto novo da revisão 2)");
    expect(await foto("josefo-antiguidades")).toBe(antes);
    expect(r.inseridos + r.atualizados + r.removidos).toBe(0);
    expect(r.maisNovasNoBanco).toEqual([
      { slug: "josefo-antiguidades", revisaoDoBanco: 2, revisaoDoBuild: 1 },
    ]);
    // Pulada com aviso não é falha: o código de saída é 0.
    expect(
      codigoDeSaida({ carregadas: 1, puladas: [], resultado: r }),
      "pular por revisão mais nova é aviso, saída 0",
    ).toBe(0);
  });

  it("o comando inteiro (lock, aviso, saída 0): build de uma versão anterior imprime o aviso e não toca na Fonte", async () => {
    await apagarTudo();
    await carregarFontes([item(2, "b", { alterar: novo as never })], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    const saida: string[] = [];
    const raiz = montarPastas(1);
    const r = await executarCarga(raiz.opcoes, {
      abrir: abrirCliente,
      escrever: (l) => saida.push(l),
    });
    expect(codigoDeSaida(r)).toBe(0);
    expect(saida.find((l) => l.startsWith("aviso: josefo-antiguidades:"))).toContain(
      "o banco já tem a revisão 2 do derivado e este build traz a 1",
    );
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("(b) o build nunca apaga, nem quando o derivado não tem uma seção ou um parágrafo que o banco tem", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(2);

    // Revisão NOVA (3) e derivado sem a seção 20 (e sem o parágrafo 20.197): o que o banco tem fica.
    const semSecao20 = (b: { secoes: unknown[] }) => {
      b.secoes.splice(1, 1);
    };
    const r = await carregarFontes(
      [item(3, "c", { soSecao18: true, alterar: semSecao20 as never })],
      { cliente: carga },
    );
    expect(r.removidos).toBe(0);
    expect(r.secoes.removidos + r.paragrafos.removidos).toBe(0);
    expect(r.mantidos).toEqual({ secoes: 1, paragrafos: 1 });
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(2);
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(2);
    // O conteúdo ficou igual; só o registro da revisão carregada subiu para 3.
    const depois = JSON.parse(await foto("josefo-antiguidades")) as unknown[][];
    expect(depois.slice(0, 2)).toEqual((JSON.parse(antes) as unknown[][]).slice(0, 2));
    expect((depois[2] as { derivado_revisao: number }[])[0]?.derivado_revisao).toBe(3);
  });

  it("(b) o comando imprime que o que sumiu ficou e como apagar de propósito", async () => {
    await apagarTudo();
    // Revisão 3 completa no banco; a revisão 4 chega sem a seção 20 (derivado e YAML).
    await executarCarga(montarPastas(3).opcoes, { abrir: abrirCliente, escrever: () => {} });
    const saida: string[] = [];
    const r = await executarCarga(montarPastas(4, { semSecao20: true }).opcoes, {
      abrir: abrirCliente,
      escrever: (l) => saida.push(l),
    });
    expect(codigoDeSaida(r)).toBe(0);
    expect(saida.join("\n")).toContain("ficaram no banco 1 parágrafos e 1 seções");
    expect(saida.join("\n")).toContain("--remover");
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(2);
  });

  it("a remoção é só de propósito: o id listado sai, o resto fica, e seção leva os parágrafos dela", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const semSecao20 = (b: { secoes: unknown[] }) => {
      b.secoes.splice(1, 1);
    };
    const r = await carregarFontes(
      [item(3, "c", { soSecao18: true, alterar: semSecao20 as never })],
      { cliente: carga, remocoesAutorizadas: ["josefo-antiguidades/20"] },
    );
    expect(r.secoes.removidos).toBe(1);
    expect(r.paragrafos.removidos).toBe(1);
    expect(r.mantidos).toEqual({ secoes: 0, paragrafos: 0 });
    expect(await contar("select count(*) n from acervo.fonte_secao")).toBe(1);
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(1);
  });

  it("autorização que não casa com nada (id errado) falha a carga inteira sem gravar", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    await expect(
      carregarFontes([item(2, "b", { alterar: novo as never })], {
        cliente: carga,
        // 18.63 NÃO sumiu do derivado; 99.1 não existe.
        remocoesAutorizadas: ["josefo-antiguidades/18.63", "josefo-antiguidades/99.1"],
      }),
    ).rejects.toThrow(/remoção autorizada que não se aplicou/);
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("(c) controle negativo: outra Fonte fica intacta, com o derivado velho pulado e com a remoção autorizada em outra", async () => {
    await apagarTudo();
    const comExtra = (b: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) =>
      b.secoes[0]?.paragrafos.push({ ref: "18.66", texto: "Só na outra." });
    // Josefo na revisão 2 (tem o 18.65); a outra Fonte na revisão 1, com um parágrafo (18.66) que o derivado dela
    // da revisão seguinte não terá.
    await carregarFontes(
      [
        item(2, "b", { alterar: novo as never }),
        item(1, "a", { slug: "outra-fonte", alterar: comExtra as never }),
      ],
      { cliente: carga },
    );
    const outraAntes = await foto("outra-fonte");
    const josefoAntes = await foto("josefo-antiguidades");

    // Josefo pulada (build velho, revisão 1 < 2); a outra avança de revisão sem o 18.66, e sem autorização ele fica.
    const r = await carregarFontes([item(1, "a"), item(2, "7", { slug: "outra-fonte" })], {
      cliente: carga,
    });
    expect(r.maisNovasNoBanco.map((x) => x.slug)).toEqual(["josefo-antiguidades"]);
    expect(r.mantidos).toEqual({ secoes: 0, paragrafos: 1 });
    expect(await foto("josefo-antiguidades")).toBe(josefoAntes);
    expect(
      await contar("select count(*) n from acervo.fonte_paragrafo where id = 'outra-fonte/18.66'"),
    ).toBe(1);

    // Remoção autorizada de UM id da Josefo (o 18.65 sai do derivado dela) não encosta na outra: o 18.66 dela fica.
    const outraDepois = await foto("outra-fonte");
    const r2 = await carregarFontes([item(3, "8"), item(2, "7", { slug: "outra-fonte" })], {
      cliente: carga,
      remocoesAutorizadas: ["josefo-antiguidades/18.65"],
    });
    expect(r2.paragrafos.removidos).toBe(1);
    expect(
      await contar(
        "select count(*) n from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.65'",
      ),
    ).toBe(0);
    expect(await foto("outra-fonte")).toBe(outraDepois);
    expect(outraDepois).not.toBe(outraAntes); // controle: a outra tinha mesmo avançado de revisão no passo anterior
  });

  it("(d) o teto aborta a Fonte SEM nenhuma escrita: nada muda no banco, e a carga sai com 3", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    // Mais parágrafos novos que o teto padrão.
    const muitos = (b: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) => {
      for (let i = 0; i < TETO_DE_UNIDADES_POR_FONTE + 10; i++)
        b.secoes[0]?.paragrafos.push({ ref: `18.${1000 + i}`, texto: `Parágrafo ${i}.` });
    };
    const r = await carregarFontes([item(2, "b", { alterar: muitos as never })], {
      cliente: carga,
    });
    expect(r.recusadasPeloTeto).toEqual([
      {
        slug: "josefo-antiguidades",
        unidades: TETO_DE_UNIDADES_POR_FONTE + 10,
        teto: TETO_DE_UNIDADES_POR_FONTE,
      },
    ]);
    expect(r.inseridos + r.atualizados + r.removidos).toBe(0);
    expect(await foto("josefo-antiguidades")).toBe(antes);
    expect(codigoDeSaida({ carregadas: 1, puladas: [], resultado: r })).toBe(3);
  });

  it("(d) a linha da recusa pelo teto é a que o build imprime como aviso, e o outro Fonte da mesma carga é carregada", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const raiz = montarPastas(2, { muitos: true });
    const saida: string[] = [];
    const r = await executarCarga(raiz.opcoes, {
      abrir: abrirCliente,
      escrever: (l) => saida.push(l),
    });
    expect(codigoDeSaida(r)).toBe(3);
    const avisos = linhasDeConflito(saida.join("\n"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("recusada: josefo-antiguidades escreveria");
    expect(avisos[0]).toContain("--teto");
    // Nada foi escrito: o banco segue na revisão 1.
    expect(await contar("select count(*) n from acervo.fonte_paragrafo")).toBe(2);
  });

  it("(d) o teto vale por unidade escrita: exatamente no teto passa, um a mais não", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    // A revisão 2 muda 1 parágrafo e insere 1 (2 unidades).
    const dentro = await carregarFontes([item(2, "b", { alterar: novo as never })], {
      cliente: carga,
      tetoDeUnidades: 2,
    });
    expect(dentro.recusadasPeloTeto).toEqual([]);
    expect(dentro.paragrafos.inseridos + dentro.paragrafos.atualizados).toBe(2);
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const fora = await carregarFontes([item(2, "b", { alterar: novo as never })], {
      cliente: carga,
      tetoDeUnidades: 1,
    });
    expect(fora.recusadasPeloTeto).toHaveLength(1);
    expect(fora.paragrafos.inseridos + fora.paragrafos.atualizados).toBe(0);
  });

  it("Fonte nova (primeira carga) não tem teto: só insere", async () => {
    await apagarTudo();
    const r = await carregarFontes([item(1, "a")], { cliente: carga, tetoDeUnidades: 1 });
    expect(r.recusadasPeloTeto).toEqual([]);
    expect(r.paragrafos.inseridos).toBe(2);
  });

  it("mesma revisão com outro sha256 é erro (a revisão tem de subir quando o derivado muda) e nada é gravado", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const antes = await foto("josefo-antiguidades");
    await expect(
      carregarFontes([item(1, "e", { alterar: novo as never })], { cliente: carga }),
    ).rejects.toThrow(ErroCarga);
    expect(await foto("josefo-antiguidades")).toBe(antes);
  });

  it("Fonte carregada antes da migração (sem revisão registrada) é aceita e passa a ter a revisão registrada", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    await dono.query(
      "update acervo.fonte set derivado_revisao = null, derivado_sha256 = null where slug = 'josefo-antiguidades'",
    );
    await carregarFontes([item(5, "f")], { cliente: carga });
    const [f] = await linhas(
      "select derivado_revisao, derivado_sha256 from acervo.fonte where slug = 'josefo-antiguidades'",
    );
    expect(f).toEqual({ derivado_revisao: 5, derivado_sha256: SHA("f") });
  });

  it("revisão maior, mesmo derivado antigo: a Fonte avança e a revisão registrada sobe", async () => {
    await apagarTudo();
    await carregarFontes([item(1, "a")], { cliente: carga });
    const r = await carregarFontes([item(2, "b", { alterar: novo as never })], { cliente: carga });
    expect(r.maisNovasNoBanco).toEqual([]);
    expect(r.paragrafos.atualizados).toBe(1);
    expect(r.paragrafos.inseridos).toBe(1);
    expect(await contar("select count(*) n from acervo.fonte where derivado_revisao = 2")).toBe(1);
  });
});

// ───────────────────────── o comando, com lock e pastas temporárias ─────────────────────────

const abrirCliente = async (): Promise<pg.Client> => {
  const c = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await c.connect();
  return c;
};

/** Pastas temporárias com a Fonte de fixture, o derivado e um lock com a revisão pedida (sha256 e bytes de verdade). */
function montarPastas(
  revisao: number,
  como: { semSecao20?: boolean; muitos?: boolean } = {},
): { opcoes: { fontes: string; derivados: string; lock: string } } {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-nunca-tras-"));
  temporarios.push(raiz);
  const fontes = path.join(raiz, "fontes");
  const derivados = path.join(raiz, "derivados");
  mkdirSync(fontes);
  mkdirSync(derivados);
  cpSync(path.join(FIXTURES, "fontes"), fontes, { recursive: true });
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  ) as { secoes: { paragrafos: { ref: string; texto: string }[] }[] };
  if (como.semSecao20) {
    bruto.secoes.splice(1, 1);
    // O YAML da Fonte também deixa de listar a seção 20 (o contrato exige que toda seção do YAML exista no derivado).
    const arquivo = path.join(fontes, "josefo-antiguidades.yaml");
    const y = parse(readFileSync(arquivo, "utf8")) as { secoes: { slug: string }[] };
    y.secoes = y.secoes.filter((x) => x.slug !== "20");
    writeFileSync(arquivo, stringify(y));
  }
  if (como.muitos)
    for (let i = 0; i < TETO_DE_UNIDADES_POR_FONTE + 10; i++)
      bruto.secoes[0]?.paragrafos.push({ ref: `18.${1000 + i}`, texto: `Parágrafo ${i}.` });
  const json = JSON.stringify(bruto);
  writeFileSync(path.join(derivados, "josefo-antiguidades.json"), json);
  const lock = path.join(raiz, "lock.json");
  writeFileSync(
    lock,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {
        "josefo-antiguidades": {
          sha256: createHash("sha256").update(json).digest("hex"),
          bytes: Buffer.byteLength(json),
          revisao,
        },
      },
    }),
  );
  return { opcoes: { fontes, derivados, lock } };
}
