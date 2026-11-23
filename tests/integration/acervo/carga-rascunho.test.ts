import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { hashDaFicha, hashDoItem, itensDaFicha } from "@/modules/acervo/hash-ficha";
import { type FichaYaml, interpretarFichaYaml } from "@/modules/acervo/schemas";
import { carregarRascunhos, executarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { ErroCarga } from "../../../scripts/ingest/carregar-biblia";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Carregador de rascunhos (ACER-03, D-03, D-17): só grava rascunho, é idempotente, preserva a conferência do que
// não mudou e nunca toca a evidência. Cria dado de teste: banco descartável SÓ deste arquivo, fora do Neon.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let migra: pg.Client;

const yamlDaFixture = (nome = "obra-de-teste.yaml") =>
  readFileSync(path.join(PASTA_FIXTURES, nome), "utf8");
const ficha = (yaml = yamlDaFixture()): FichaYaml =>
  interpretarFichaYaml(yaml, "obra-de-teste.yaml");
const contar = async (sql: string) => Number((await migra.query(sql)).rows[0]?.n);

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  migra = new pg.Client({ connectionString: urlDoPapel("migra", { agrupada: false }) });
  await migra.connect();
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await migra?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("carga de rascunho de ficha", () => {
  it("grava a Fonte de ficha, a ficha e os itens com os hashes canônicos, tudo como rascunho", async () => {
    const f = ficha();
    const r = await carregarRascunhos([f], { cliente: carga });
    // 1 Fonte + 1 ficha + 3 itens.
    expect(r).toMatchObject({ inseridas: 5, atualizadas: 0, inalteradas: 0, removidas: 0 });

    const fonte = (
      await migra.query(
        `select tipo_texto, obra_protegida, publicada, nivel, autor, titulo, idioma, limites_pt
           from acervo.fonte where slug = 'obra-de-teste'`,
      )
    ).rows[0];
    expect(fonte).toEqual({
      tipo_texto: "ficha",
      obra_protegida: true,
      publicada: false,
      nivel: "academica",
      autor: "Autora de Teste",
      titulo: "Obra de Teste",
      idioma: "en",
      limites_pt: "Obra inventada; nada nela é fato histórico.",
    });

    const itens = itensDaFicha(f);
    const linha = (
      await migra.query(
        `select fi.edicao_consultada, fi.ano, fi.editora, fi.origem_do_rascunho, fi.conteudo_hash
           from acervo.ficha fi join acervo.fonte fo on fo.id = fi.fonte_id where fo.slug = 'obra-de-teste'`,
      )
    ).rows[0];
    expect(linha.edicao_consultada).toBe("Primeira edição de teste, 2001");
    expect(linha.ano).toBe(2001);
    expect(linha.origem_do_rascunho).toBe("memoria-do-modelo");
    expect(linha.conteudo_hash).toBe(hashDaFicha(f, itens));

    const doBanco = (
      await migra.query(
        `select id, tipo, ordem, pagina_inicio, pagina_fim, pagina_texto, trecho_original, idioma_trecho,
                confianca, conteudo_hash from acervo.ficha_item order by tipo, ordem`,
      )
    ).rows;
    expect(doBanco.map((i) => i.id)).toEqual([
      "obra-de-teste/argumento-1",
      "obra-de-teste/argumento-2",
      "obra-de-teste/trecho-1",
    ]);
    expect(doBanco.map((i) => i.conteudo_hash)).toEqual(itens.map(hashDoItem));
    // Página numérica vira inteiros; a outra forma vai em pagina_texto.
    expect(doBanco[0]).toMatchObject({ pagina_inicio: 10, pagina_fim: 10, pagina_texto: null });
    expect(doBanco[1]).toMatchObject({ pagina_inicio: 12, pagina_fim: 14, pagina_texto: null });
    expect(doBanco[2]).toMatchObject({
      pagina_inicio: null,
      pagina_fim: null,
      pagina_texto: "xi-xii",
      idioma_trecho: "en",
    });
    expect(doBanco[2].trecho_original).toContain("invented test sentence");
    expect(doBanco[0]).toMatchObject({ trecho_original: null, idioma_trecho: null });
  });

  it("não grava evidência: nenhuma verificação nem conferência existe depois da carga", async () => {
    expect(await contar("select count(*)::int as n from acervo.verificacao_ficha")).toBe(0);
    expect(await contar("select count(*)::int as n from acervo.conferencia_item")).toBe(0);
    expect(await contar("select count(*)::int as n from admin.registro_verificacao")).toBe(0);
  });

  it("segunda carga: inseridas=0 e atualizadas=0", async () => {
    const r = await carregarRascunhos([ficha()], { cliente: carga });
    expect(r).toMatchObject({ inseridas: 0, atualizadas: 0, inalteradas: 5, removidas: 0 });
  });

  it("mudar o texto de um item muda o hash dele e o da ficha, e NÃO apaga a conferência do que não mudou", async () => {
    const antes = ficha();
    const itensAntes = itensDaFicha(antes);
    // O dono do esquema registra a conferência dos três itens, cada uma no hash atual (a evidência só ele grava).
    for (const item of itensAntes)
      await migra.query(
        "insert into acervo.conferencia_item (item_id, item_hash) values ($1, $2)",
        [item.id, hashDoItem(item)],
      );
    const hashFichaAntes = (await migra.query("select conteudo_hash from acervo.ficha")).rows[0]
      .conteudo_hash;

    const mudada = ficha(
      yamlDaFixture().replace("Segundo argumento de teste", "Segundo argumento de teste, revisado"),
    );
    const r = await carregarRascunhos([mudada], { cliente: carga });
    // A ficha (hash) e o item mudaram; a Fonte e os outros dois itens ficaram como estavam.
    expect(r).toMatchObject({ inseridas: 0, atualizadas: 2, inalteradas: 3, removidas: 0 });

    const hashes = (
      await migra.query("select id, conteudo_hash from acervo.ficha_item order by tipo, ordem")
    ).rows;
    const itensDepois = itensDaFicha(mudada);
    expect(hashes.map((h) => h.conteudo_hash)).toEqual(itensDepois.map(hashDoItem));
    expect(hashes[0].conteudo_hash).toBe(hashDoItem(itensAntes[0] as never));
    expect(hashes[1].conteudo_hash).not.toBe(hashDoItem(itensAntes[1] as never));
    const hashFichaDepois = (await migra.query("select conteudo_hash from acervo.ficha")).rows[0]
      .conteudo_hash;
    expect(hashFichaDepois).not.toBe(hashFichaAntes);
    expect(hashFichaDepois).toBe(hashDaFicha(mudada, itensDepois));

    // As três linhas de conferência continuam (a carga nunca as toca); só a do item mudado deixa de bater
    // com o hash atual, ou seja, só aquele item volta a "a conferir".
    const conferidos = (
      await migra.query(
        `select c.item_id, (c.item_hash = i.conteudo_hash) as confere
           from acervo.conferencia_item c join acervo.ficha_item i on i.id = c.item_id order by 1`,
      )
    ).rows;
    expect(conferidos).toEqual([
      { item_id: "obra-de-teste/argumento-1", confere: true },
      { item_id: "obra-de-teste/argumento-2", confere: false },
      { item_id: "obra-de-teste/trecho-1", confere: true },
    ]);
  });

  it("item que sai do YAML é apagado junto com a conferência dele", async () => {
    const semOTrecho = ficha(
      yamlDaFixture()
        .replace("Segundo argumento de teste", "Segundo argumento de teste, revisado")
        .replace(/ {2}- tipo: trecho[\s\S]*$/m, ""),
    );
    const r = await carregarRascunhos([semOTrecho], { cliente: carga });
    expect(r.removidas).toBe(1);
    expect(await contar("select count(*)::int as n from acervo.ficha_item")).toBe(2);
    expect(await contar("select count(*)::int as n from acervo.conferencia_item")).toBe(2);
  });

  it("não toca Fonte que não é de ficha", async () => {
    await carga.query(
      `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, licenca, origem_url, origem_nome)
       values ('texto-integral-alheio', 'Texto', 'primaria', 'integral', 'en', 'dominio-publico',
               'https://exemplo.invalid/t', 'Origem')`,
    );
    const intruso = ficha(
      yamlDaFixture().replace("slug: obra-de-teste", "slug: texto-integral-alheio"),
    );
    await expect(carregarRascunhos([intruso], { cliente: carga })).rejects.toThrow(ErroCarga);
    await expect(carregarRascunhos([intruso], { cliente: carga })).rejects.toThrow(
      /não é de ficha/,
    );
    const r = await migra.query(
      "select titulo from acervo.fonte where slug = 'texto-integral-alheio'",
    );
    expect(r.rows).toEqual([{ titulo: "Texto" }]);
  });

  it("uma falha no meio desfaz a carga inteira", async () => {
    const boa = ficha(yamlDaFixture("obra-de-teste-edicao-pendente.yaml"));
    const antes = await contar("select count(*)::int as n from acervo.fonte");
    // A segunda ficha cai na Fonte integral do teste anterior e falha: a primeira não pode ficar.
    const intruso = ficha(
      yamlDaFixture().replace("slug: obra-de-teste", "slug: texto-integral-alheio"),
    );
    await expect(carregarRascunhos([boa, intruso], { cliente: carga })).rejects.toThrow(ErroCarga);
    expect(await contar("select count(*)::int as n from acervo.fonte")).toBe(antes);
  });

  it("o papel de carga não grava verificação nem conferência, por privilégio", async () => {
    await expect(
      carga.query(
        "insert into acervo.verificacao_ficha (ficha_id, ficha_hash) select fonte_id, conteudo_hash from acervo.ficha",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      carga.query(
        "insert into acervo.conferencia_item (item_id, item_hash) values ('x/argumento-9', $1)",
        ["a".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(carga.query("delete from acervo.conferencia_item")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("o carregador nunca cita as tabelas de evidência em SQL de escrita", () => {
    const fonte = readFileSync(
      path.join(RAIZ, "scripts", "acervo", "carregar-rascunhos.ts"),
      "utf8",
    );
    expect(fonte).not.toMatch(
      /(insert\s+into|update|delete\s+from)\s+(acervo\.)?(verificacao_ficha|conferencia_item)/i,
    );
    expect(fonte).not.toMatch(/registro_verificacao/);
    // Controle: o detector acusa o que procura.
    expect("insert into acervo.verificacao_ficha").toMatch(
      /insert\s+into\s+acervo\.verificacao_ficha/,
    );
  });
});

describe("comando pnpm acervo:rascunhos", () => {
  const env = (extra: Record<string, string> = {}) => {
    const limpo = { ...process.env, ...extra };
    if (!("ACERVO_FICHAS_DIR" in extra)) delete limpo.ACERVO_FICHAS_DIR;
    return limpo;
  };

  it("sem --fichas e sem ACERVO_FICHAS_DIR sai 1 dizendo que a pasta é obrigatória", () => {
    const r = spawnSync("node_modules/.bin/tsx", ["scripts/acervo/carregar-rascunhos.ts"], {
      cwd: RAIZ,
      env: env(),
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/pasta de fichas é obrigatória/);
    expect(r.stderr).toMatch(/--fichas/);
    expect(r.stdout).toBe("");
  });

  it("executarRascunhos recusa a falta de pasta antes de abrir conexão", async () => {
    let abriu = false;
    await expect(
      executarRascunhos(
        { fichas: undefined },
        {
          abrir: async () => {
            abriu = true;
            throw new Error("não deveria abrir");
          },
        },
      ),
    ).rejects.toThrow(/pasta de fichas é obrigatória/);
    expect(abriu).toBe(false);
  });

  it("YAML com estado de verificação é recusado antes de abrir conexão", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pasta = mkdtempSync(path.join(tmpdir(), "jnf-rascunhos-"));
    try {
      writeFileSync(
        path.join(pasta, "x.yaml"),
        yamlDaFixture().replace("estado: rascunho", "estado: verificada"),
      );
      let abriu = false;
      await expect(
        executarRascunhos(
          { fichas: pasta },
          {
            abrir: async () => {
              abriu = true;
              throw new Error("não deveria abrir");
            },
          },
        ),
      ).rejects.toThrow(/estado/);
      expect(abriu).toBe(false);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
