import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

describe.skipIf(emNeon())("carga com seleção do dono (--selecao)", () => {
  // Plano 02-25: `--selecao <arquivo>` carrega só as obras com `tenho: sim`, grava a edição que o dono
  // informou no lugar da suposta pelo redator e continua sem nunca gravar verificação. Fichas
  // sintéticas da pasta selecao/, lidas pela fixture selecao-de-teste.yaml.
  const PASTA_SELECAO = path.join(PASTA_FIXTURES, "..", "selecao");
  const SELECAO = path.join(PASTA_FIXTURES, "..", "selecao-de-teste.yaml");
  const semBanco = () => {
    const limpo = { ...process.env };
    delete limpo.ACERVO_FICHAS_DIR;
    delete limpo.ACERVO_PROPOSTAS_DIR;
    for (const chave of Object.keys(limpo))
      if (/DATABASE|PG|NEON|DB_/i.test(chave)) delete limpo[chave];
    return limpo;
  };
  const abrirNova = async () => {
    const c = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
    await c.connect();
    return c;
  };
  const edicaoNoBanco = async (slug: string) =>
    (
      await migra.query(
        `select fi.edicao_consultada from acervo.ficha fi
           join acervo.fonte fo on fo.id = fi.fonte_id where fo.slug = $1`,
        [slug],
      )
    ).rows[0]?.edicao_consultada as string | undefined;
  const comSelecaoTemporaria = (
    conteudo: string,
    corpo: (arquivo: string) => void | Promise<void>,
  ) => {
    const pasta = mkdtempSync(path.join(tmpdir(), "jnf-selecao-"));
    const arquivo = path.join(pasta, "selecao.yaml");
    try {
      writeFileSync(arquivo, conteudo);
      return corpo(arquivo);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  };

  it("carrega só as obras com tenho: sim; as com nao não são lidas para o banco", async () => {
    const linhas: string[] = [];
    const r = await executarRascunhos(
      { fichas: PASTA_SELECAO, selecao: SELECAO },
      { abrir: abrirNova, escrever: (l) => linhas.push(l) },
    );
    // Só a obra marcada entra: 1 Fonte + 1 ficha + 1 item.
    expect(r).toMatchObject({ fichas: 1, inseridas: 3 });
    expect(await edicaoNoBanco("obra-selecionada-de-teste")).toBeDefined();
    expect(await edicaoNoBanco("obra-nao-marcada-de-teste")).toBeUndefined();
    expect(linhas.some((l) => l.includes("obra-nao-marcada-de-teste"))).toBe(true);
    expect(linhas.some((l) => /nunca é verificada|nenhuma é verificada/.test(l))).toBe(true);
  });

  it("a edição informada substitui a edicao_consultada no banco, e o YAML da ficha não é alterado", async () => {
    expect(await edicaoNoBanco("obra-selecionada-de-teste")).toBe(
      "Edição de teste informada pelo dono, 2011",
    );
    // O arquivo da ficha continua com a edição suposta pelo redator: a seleção não toca o YAML.
    const yaml = readFileSync(path.join(PASTA_SELECAO, "obra-selecionada-de-teste.yaml"), "utf8");
    expect(yaml).toContain("A confirmar: edição de teste suposta pelo redator, 2011");
    expect(yaml).not.toContain("Edição de teste informada pelo dono");
  });

  it("tenho: sim com edição vazia sai 1, nomeia a obra e não grava nada", async () => {
    await comSelecaoTemporaria(
      ["obras:", "  - slug: obra-nao-marcada-de-teste", "    tenho: sim", '    edicao: ""'].join(
        "\n",
      ),
      async (arquivo) => {
        await expect(
          executarRascunhos(
            { fichas: PASTA_SELECAO, selecao: arquivo },
            {
              abrir: async () => {
                throw new Error("não deveria abrir conexão");
              },
            },
          ),
        ).rejects.toThrow(/obra-nao-marcada-de-teste/);
        // Nada foi gravado: a obra da seleção inválida não existe no banco.
        expect(await edicaoNoBanco("obra-nao-marcada-de-teste")).toBeUndefined();
      },
    );
  });

  it.each([
    "A confirmar: edição que o redator supôs",
    "a confirmar: edição pendente",
    "A CONFIRMAR",
  ])(
    "tenho: sim com edição ainda '%s' sai 1 pelo comando, nomeando a obra e sem abrir o banco",
    (edicao) => {
      const pasta = mkdtempSync(path.join(tmpdir(), "jnf-selecao-"));
      try {
        writeFileSync(
          path.join(pasta, "selecao.yaml"),
          [
            "obras:",
            "  - slug: obra-nao-marcada-de-teste",
            "    tenho: sim",
            `    edicao: "${edicao}"`,
          ].join("\n"),
        );
        const r = spawnSync(
          "node_modules/.bin/tsx",
          [
            "scripts/acervo/carregar-rascunhos.ts",
            "--fichas",
            PASTA_SELECAO,
            "--selecao",
            path.join(pasta, "selecao.yaml"),
          ],
          { cwd: RAIZ, env: semBanco(), encoding: "utf8" },
        );
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/obra-nao-marcada-de-teste/);
        expect(r.stderr).toMatch(/edição/);
      } finally {
        rmSync(pasta, { recursive: true, force: true });
      }
    },
  );

  it("slug na seleção sem ficha na pasta e ficha fora da seleção são relatados, sem erro", async () => {
    await comSelecaoTemporaria(
      [
        "obras:",
        "  - slug: obra-selecionada-de-teste",
        "    tenho: sim",
        '    edicao: "Edição de teste informada pelo dono, 2011"',
        "  - slug: obra-inexistente-de-teste",
        "    tenho: sim",
        '    edicao: "Edição de teste qualquer, 1999"',
      ].join("\n"),
      async (arquivo) => {
        const linhas: string[] = [];
        const r = await executarRascunhos(
          { fichas: PASTA_SELECAO, selecao: arquivo },
          { abrir: abrirNova, escrever: (l) => linhas.push(l) },
        );
        // A obra marcada e existente carrega (já carregada acima: inalterada); a ausente é relatada.
        expect(r).toMatchObject({ fichas: 1, inseridas: 0, atualizadas: 0 });
        expect(linhas.some((l) => /sem ficha na pasta: obra-inexistente-de-teste/.test(l))).toBe(
          true,
        );
        expect(linhas.some((l) => /fora da seleção: obra-nao-marcada-de-teste/.test(l))).toBe(true);
        // A obra inexistente não criou nada.
        expect(await edicaoNoBanco("obra-inexistente-de-teste")).toBeUndefined();
      },
    );
  });

  it("a carga com seleção é idempotente e continua sem gravar verificação", async () => {
    // O banco descartável é compartilhado com a suíte anterior (que deixa conferências de teste):
    // o que se prova é que a carga com seleção NÃO toca a evidência — as contagens não mudam.
    const antes = {
      verificacao: await contar("select count(*)::int as n from acervo.verificacao_ficha"),
      conferencia: await contar("select count(*)::int as n from acervo.conferencia_item"),
      registro: await contar("select count(*)::int as n from admin.registro_verificacao"),
    };
    expect(antes.verificacao).toBe(0);
    expect(antes.registro).toBe(0);
    const r = await executarRascunhos(
      { fichas: PASTA_SELECAO, selecao: SELECAO },
      { abrir: abrirNova, escrever: () => {} },
    );
    expect(r).toMatchObject({ fichas: 1, inseridas: 0, atualizadas: 0, inalteradas: 3 });
    expect(await contar("select count(*)::int as n from acervo.verificacao_ficha")).toBe(
      antes.verificacao,
    );
    expect(await contar("select count(*)::int as n from acervo.conferencia_item")).toBe(
      antes.conferencia,
    );
    expect(await contar("select count(*)::int as n from admin.registro_verificacao")).toBe(
      antes.registro,
    );
  });

  it("--so-validar com seleção confere o contrato e a seleção, sai 0 e não usa banco", () => {
    const r = spawnSync(
      "node_modules/.bin/tsx",
      [
        "scripts/acervo/carregar-rascunhos.ts",
        "--fichas",
        PASTA_SELECAO,
        "--selecao",
        SELECAO,
        "--so-validar",
      ],
      { cwd: RAIZ, env: semBanco(), encoding: "utf8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^OK obra-selecionada-de-teste$/m);
    expect(r.stdout).toMatch(/reprovadas=0/);
    expect(r.stdout).toMatch(/selecionadas=1 de fichas=2/);
    expect(r.stdout).not.toMatch(/inseridas=/);
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

  describe("modo --so-validar (confere o contrato sem abrir conexão)", () => {
    const tsx = "node_modules/.bin/tsx";
    const script = "scripts/acervo/carregar-rascunhos.ts";
    // Sem nenhuma variável de banco: se o modo tentasse conectar, falharia por falta de URL.
    const semBanco = () => {
      const limpo = env();
      for (const chave of Object.keys(limpo))
        if (/DATABASE|PG|NEON|DB_/i.test(chave)) delete limpo[chave];
      return limpo;
    };
    const comPastaTemporaria = async (
      arquivos: Record<string, string>,
      corpo: (pasta: string) => void | Promise<void>,
    ) => {
      const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const pasta = mkdtempSync(path.join(tmpdir(), "jnf-so-validar-"));
      try {
        for (const [nome, conteudo] of Object.entries(arquivos))
          writeFileSync(path.join(pasta, nome), conteudo);
        await corpo(pasta);
      } finally {
        rmSync(pasta, { recursive: true, force: true });
      }
    };

    it("aprova a pasta de fixtures: imprime OK por slug, sai 0 e não usa banco", () => {
      const r = spawnSync(tsx, [script, "--fichas", PASTA_FIXTURES, "--so-validar"], {
        cwd: RAIZ,
        env: semBanco(),
        encoding: "utf8",
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^OK obra-de-teste$/m);
      expect(r.stdout).toMatch(/reprovadas=0/);
      expect(r.stdout).not.toMatch(/inseridas=/);
    });

    it("reprova a ficha adulterada (estado: verificada) e sai 1 sem parar nas outras", async () => {
      await comPastaTemporaria(
        {
          "boa.yaml": yamlDaFixture(),
          "adulterada.yaml": yamlDaFixture("obra-de-teste-edicao-pendente.yaml").replace(
            "estado: rascunho",
            "estado: verificada",
          ),
        },
        (pasta) => {
          const r = spawnSync(tsx, [script, "--fichas", pasta, "--so-validar"], {
            cwd: RAIZ,
            env: semBanco(),
            encoding: "utf8",
          });
          expect(r.status).toBe(1);
          expect(r.stdout).toMatch(/^OK obra-de-teste$/m);
          expect(r.stdout).toMatch(/REPROVADA .*adulterada\.yaml fora do contrato: .*estado/);
          expect(r.stdout).toMatch(/reprovadas=1/);
        },
      );
    });

    it("exige a pasta como o modo de carga: sem pasta, sai 1", () => {
      const r = spawnSync(tsx, [script, "--so-validar"], {
        cwd: RAIZ,
        env: semBanco(),
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/pasta de fichas é obrigatória/);
    });

    it("executarRascunhos com soValidar nunca chama abrir()", async () => {
      let abriu = false;
      const linhas: string[] = [];
      const r = await executarRascunhos(
        { fichas: PASTA_FIXTURES, soValidar: true },
        {
          abrir: async () => {
            abriu = true;
            throw new Error("não deveria abrir");
          },
          escrever: (l) => linhas.push(l),
        },
      );
      expect(r).toBeNull();
      expect(abriu).toBe(false);
      expect(linhas).toContain("OK obra-de-teste");
    });

    it("slug repetido na pasta reprova", async () => {
      await comPastaTemporaria(
        { "a.yaml": yamlDaFixture(), "b.yaml": yamlDaFixture() },
        (pasta) => {
          const r = spawnSync(tsx, [script, "--fichas", pasta, "--so-validar"], {
            cwd: RAIZ,
            env: semBanco(),
            encoding: "utf8",
          });
          expect(r.status).toBe(1);
          expect(r.stdout).toMatch(/ficha repetida na pasta: obra-de-teste/);
        },
      );
    });
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
