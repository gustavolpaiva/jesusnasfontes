import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { hashDaFicha, hashDoItem, itensDaFicha } from "@/modules/acervo/hash-ficha";
import type { FichaYaml } from "@/modules/acervo/schemas";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Integridade da ficha verificada (ACER-03, D-02, D-03), achado ALTA da revisão cruzada do plano 02-02: o hash do
// conteúdo é calculado NO BANCO. Quem escreve conteúdo (carga ou dono do esquema) não escolhe o hash, e qualquer
// mudança no que o hash cobre (ficha, itens, campos da Fonte) invalida a verificação. Cria dado de teste: banco
// descartável SÓ deste arquivo, fora do Neon.

const emNeon = () => inject("alvoBanco") === "neon";
const HASH_FALSO = "f".repeat(64);
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let migra: pg.Client;
let app: pg.Client;

async function cliente(papel: "carga" | "migra" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

let n = 0;
type Verificada = { fonteId: string; slug: string };

/**
 * Ficha com um argumento e um trecho, criada COMO O PAPEL DE CARGA, e verificada pelo dono do esquema (o único que
 * grava evidência), para o hash que o banco calculou.
 */
async function fichaVerificada(opcoes: { semTrecho?: boolean } = {}): Promise<Verificada> {
  n++;
  const slug = `ficha-de-teste-${n}`;
  const fonte = await carga.query<{ id: string }>(
    `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, obra_protegida, publicada, limites_pt)
     values ($1, 'Obra de Teste', 'Autora de Teste', 'academica', 'ficha', 'en', true, false, 'Limites de teste.')
     returning id`,
    [slug],
  );
  const fonteId = (fonte.rows[0] as { id: string }).id;
  await carga.query(
    `insert into acervo.ficha (fonte_id, edicao_consultada, ano, editora, tese_pt, idioma_trechos, conteudo_hash)
     values ($1, '1ª edição de teste', 2001, 'Editora de Teste', 'Tese de teste.', 'en', $2)`,
    [fonteId, HASH_FALSO],
  );
  await carga.query(
    `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim, confianca, conteudo_hash)
     values ($1, $2, 'argumento', 1, 'Argumento de teste.', 10, 10, 'media', $3)`,
    [`${slug}/argumento-1`, fonteId, HASH_FALSO],
  );
  if (!opcoes.semTrecho)
    await carga.query(
      `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_texto, trecho_original,
         idioma_trecho, confianca, conteudo_hash)
       values ($1, $2, 'trecho', 1, 'Trecho de teste.', 'xi-xii', 'Original quote.', 'en', 'baixa', $3)`,
      [`${slug}/trecho-1`, fonteId, HASH_FALSO],
    );
  await verificar(fonteId);
  return { fonteId, slug };
}

/** O dono do esquema (stand-in da função de verificação do plano 05) verifica para o hash ATUAL do banco. */
async function verificar(fonteId: string) {
  await migra.query(
    `insert into acervo.verificacao_ficha (ficha_id, ficha_hash)
     select fonte_id, conteudo_hash from acervo.ficha where fonte_id = $1
     on conflict (ficha_id) do update set ficha_hash = excluded.ficha_hash, verificada_em = now()`,
    [fonteId],
  );
}

const hashAtual = async (fonteId: string) =>
  (
    (await migra.query("select conteudo_hash from acervo.ficha where fonte_id = $1", [fonteId]))
      .rows[0] as { conteudo_hash: string }
  ).conteudo_hash;

const hashDaEvidencia = async (fonteId: string) =>
  (
    (
      await migra.query("select ficha_hash from acervo.verificacao_ficha where ficha_id = $1", [
        fonteId,
      ])
    ).rows[0] as { ficha_hash: string }
  ).ficha_hash;

/** Quantas linhas da ficha o aplicativo, SEM sessão de Admin, enxerga: 1 = verificada e vigente, 0 = rascunho. */
async function visivelParaOAplicativo(fonteId: string): Promise<number> {
  const r = await app.query("select count(*)::int as n from acervo.ficha where fonte_id = $1", [
    fonteId,
  ]);
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = await cliente("carga");
  migra = await cliente("migra");
  app = await cliente("app");
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, migra, app]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("o hash da ficha é calculado no banco", () => {
  it("controle positivo: a ficha verificada é legível pelo aplicativo sem sessão alguma", async () => {
    const f = await fichaVerificada();
    expect(await visivelParaOAplicativo(f.fonteId)).toBe(1);
  });

  it("o hash enviado pela carga é ignorado: o banco grava o que ele calculou", async () => {
    const f = await fichaVerificada();
    const gravado = await hashAtual(f.fonteId);
    expect(gravado).toMatch(/^[0-9a-f]{64}$/);
    expect(gravado).not.toBe(HASH_FALSO);
    const itens = await migra.query(
      "select conteudo_hash from acervo.ficha_item where ficha_id = $1",
      [f.fonteId],
    );
    for (const linha of itens.rows) expect(linha.conteudo_hash).not.toBe(HASH_FALSO);
  });

  it("o hash do banco é o do TypeScript, byte a byte, com acento, aspas, barra, controle e emoji", async () => {
    const ficha: FichaYaml = {
      slug: "obra-de-bytes",
      titulo: 'Título com "aspas", barra \\ e acentuação: ç ã ü — 日本語 😀',
      autor: "Autora\tcom\ttabulação",
      ano: 1999,
      editora: null,
      edicao_consultada: "Edição com\nquebra de linha e controle \u0001 e separador   e </script>",
      estado: "rascunho",
      origem_do_rascunho: "consulta-direta",
      idioma_trechos: "en",
      tese_pt: "Tese com / barra, \\u00e9 literal e \u007f del.",
      limites_pt: "Limites com 'apóstrofo' e \"aspas\".",
      serve_a: [],
      itens: [
        {
          tipo: "argumento",
          texto_pt: 'Primeiro "argumento"\n\\ com barra.',
          pagina: "39-53",
          confianca: "alta",
        },
        {
          tipo: "trecho",
          texto_pt: "Trecho em português ✓.",
          pagina: "xi-xii",
          trecho_original: 'He said: "ça va" \\ ok\r\n😀',
          confianca: "media",
        },
        { tipo: "argumento", texto_pt: "Segundo argumento.", pagina: "7", confianca: "baixa" },
        {
          tipo: "trecho",
          texto_pt: "Outro trecho.",
          pagina: "8",
          trecho_original: "x",
          confianca: "baixa",
        },
      ],
    } as FichaYaml;
    const itens = itensDaFicha(ficha);
    const fonte = await carga.query<{ id: string }>(
      `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, obra_protegida, limites_pt)
       values ($1, $2, $3, 'academica', 'ficha', $4, true, $5) returning id`,
      [ficha.slug, ficha.titulo, ficha.autor, ficha.idioma_trechos, ficha.limites_pt],
    );
    const fonteId = (fonte.rows[0] as { id: string }).id;
    await carga.query(
      `insert into acervo.ficha (fonte_id, edicao_consultada, ano, editora, tese_pt, idioma_trechos, conteudo_hash)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        fonteId,
        ficha.edicao_consultada,
        ficha.ano,
        ficha.editora,
        ficha.tese_pt,
        ficha.idioma_trechos,
        HASH_FALSO,
      ],
    );
    for (const i of itens)
      await carga.query(
        `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim, pagina_texto,
           trecho_original, idioma_trecho, confianca, conteudo_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          i.id,
          fonteId,
          i.tipo,
          i.ordem,
          i.texto_pt,
          i.pagina.inicio,
          i.pagina.fim,
          i.pagina.texto,
          i.trecho_original,
          i.idioma_trecho,
          i.confianca,
          HASH_FALSO,
        ],
      );
    const doBanco = (
      await migra.query(
        "select id, conteudo_hash from acervo.ficha_item where ficha_id = $1 order by tipo, ordem",
        [fonteId],
      )
    ).rows as { id: string; conteudo_hash: string }[];
    expect(doBanco.map((l) => l.id)).toEqual(itens.map((i) => i.id));
    expect(doBanco.map((l) => l.conteudo_hash)).toEqual(itens.map(hashDoItem));
    expect(await hashAtual(fonteId)).toBe(hashDaFicha(ficha, itens));
  });
});

type Adulteracao = [rotulo: string, sql: (slug: string) => string];

const ADULTERACOES: Adulteracao[] = [
  [
    "tese_pt da ficha",
    () => "update acervo.ficha set tese_pt = 'Texto adulterado' where fonte_id = $1",
  ],
  [
    "edicao_consultada",
    () => "update acervo.ficha set edicao_consultada = 'Outra edição' where fonte_id = $1",
  ],
  ["ano", () => "update acervo.ficha set ano = 1900 where fonte_id = $1"],
  ["editora", () => "update acervo.ficha set editora = 'Outra editora' where fonte_id = $1"],
  ["idioma_trechos", () => "update acervo.ficha set idioma_trechos = 'pt' where fonte_id = $1"],
  ["título da Fonte", () => "update acervo.fonte set titulo = 'Título adulterado' where id = $1"],
  ["autor da Fonte", () => "update acervo.fonte set autor = 'Autor adulterado' where id = $1"],
  [
    "limites_pt da Fonte",
    () => "update acervo.fonte set limites_pt = 'Limites adulterados' where id = $1",
  ],
  [
    "texto_pt de um item",
    (s) =>
      `update acervo.ficha_item set texto_pt = 'Item adulterado' where id = '${s}/argumento-1'`,
  ],
  [
    "página numérica de um item",
    (s) =>
      `update acervo.ficha_item set pagina_inicio = 99, pagina_fim = 99 where id = '${s}/argumento-1'`,
  ],
  [
    "página em texto de um item",
    (s) => `update acervo.ficha_item set pagina_texto = 'xiii' where id = '${s}/trecho-1'`,
  ],
  [
    "trecho_original",
    (s) =>
      `update acervo.ficha_item set trecho_original = 'Fake quote.' where id = '${s}/trecho-1'`,
  ],
  [
    "idioma do trecho",
    (s) => `update acervo.ficha_item set idioma_trecho = 'pt' where id = '${s}/trecho-1'`,
  ],
  [
    "item novo",
    (s) =>
      `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim, confianca, conteudo_hash)
       values ('${s}/argumento-2', $1, 'argumento', 2, 'Item de fora.', 5, 5, 'alta', '${HASH_FALSO}')`,
  ],
  ["item apagado", (s) => `delete from acervo.ficha_item where id = '${s}/trecho-1'`],
  [
    "hash da ficha forjado com o valor da evidência",
    () =>
      `update acervo.ficha set tese_pt = 'Texto adulterado',
         conteudo_hash = (select ficha_hash from acervo.verificacao_ficha where ficha_id = $1) where fonte_id = $1`,
  ],
  [
    "hash do item forjado com o valor antigo",
    (s) =>
      `update acervo.ficha_item set texto_pt = 'Item adulterado',
         conteudo_hash = (select conteudo_hash from acervo.ficha_item where id = '${s}/argumento-1')
       where id = '${s}/argumento-1'`,
  ],
];

describe.skipIf(emNeon())(
  "qualquer mudança de conteúdo invalida a verificação (como carga)",
  () => {
    it.each(ADULTERACOES)("adulterar %s deixa a ficha como rascunho", async (_rotulo, sql) => {
      const f = await fichaVerificada();
      const evidencia = await hashDaEvidencia(f.fonteId);
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(1); // controle: verificada antes do ataque

      const comando = sql(f.slug);
      await carga.query(comando, comando.includes("$1") ? [f.fonteId] : []);

      expect(await hashAtual(f.fonteId)).not.toBe(evidencia);
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(0);
      // O Admin com segundo fator continua enxergando o rascunho: aqui, o rascunho foi adulterado e some do público.
      // Controle positivo: o caminho legítimo (nova verificação pelo dono, para o hash novo) a torna visível de novo.
      await verificar(f.fonteId);
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(1);
    });

    it("como dono do esquema, a mesma adulteração também invalida (o gatilho vale para todos os papéis)", async () => {
      const f = await fichaVerificada();
      await migra.query(
        "update acervo.ficha set tese_pt = 'Texto adulterado' where fonte_id = $1",
        [f.fonteId],
      );
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(0);
      await migra.query("update acervo.ficha_item set texto_pt = 'x' where id = $1", [
        `${f.slug}/argumento-1`,
      ]);
      await migra.query("update acervo.ficha set conteudo_hash = $2 where fonte_id = $1", [
        f.fonteId,
        await hashDaEvidencia(f.fonteId),
      ]);
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(0);
    });

    it("o hash é função do conteúdo: desfazer a adulteração devolve a verificação vigente", async () => {
      const f = await fichaVerificada();
      await carga.query(
        "update acervo.ficha set tese_pt = 'Texto adulterado' where fonte_id = $1",
        [f.fonteId],
      );
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(0);
      await carga.query("update acervo.ficha set tese_pt = 'Tese de teste.' where fonte_id = $1", [
        f.fonteId,
      ]);
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(1);
    });

    it("controle positivo: mudança que o hash não cobre (publicada) mantém a verificação", async () => {
      const f = await fichaVerificada();
      await carga.query("update acervo.fonte set publicada = true where id = $1", [f.fonteId]);
      expect(await visivelParaOAplicativo(f.fonteId)).toBe(1);
    });

    it("controle positivo: apagar a ficha e o que dela depende continua possível ao dono do esquema", async () => {
      const f = await fichaVerificada();
      await migra.query("delete from acervo.ficha where fonte_id = $1", [f.fonteId]);
      const r = await migra.query(
        "select count(*)::int as n from acervo.ficha_item where ficha_id = $1",
        [f.fonteId],
      );
      expect(r.rows[0].n).toBe(0);
    });
  },
);

describe.skipIf(emNeon())("chave estrangeira móvel: item e ficha não migram sem invalidar", () => {
  it("mover um item de uma ficha verificada para outra verificada invalida AS DUAS", async () => {
    const origem = await fichaVerificada();
    const destino = await fichaVerificada({ semTrecho: true });
    expect(await visivelParaOAplicativo(origem.fonteId)).toBe(1);
    expect(await visivelParaOAplicativo(destino.fonteId)).toBe(1);

    await carga.query("update acervo.ficha_item set ficha_id = $2 where id = $1", [
      `${origem.slug}/trecho-1`,
      destino.fonteId,
    ]);

    expect(await visivelParaOAplicativo(origem.fonteId)).toBe(0);
    expect(await visivelParaOAplicativo(destino.fonteId)).toBe(0);
  });

  it("mudar o fonte_id de uma ficha verificada é recusado pelo banco", async () => {
    const f = await fichaVerificada();
    // Fonte de ficha sem ficha: destino livre, para a recusa vir da evidência e não de chave repetida.
    n++;
    const destino = await carga.query<{ id: string }>(
      `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, obra_protegida)
       values ($1, 'Outra Obra', 'Outra Autora', 'academica', 'ficha', 'en', true) returning id`,
      [`ficha-de-teste-${n}`],
    );
    const destinoId = (destino.rows[0] as { id: string }).id;
    await expect(
      carga.query("update acervo.ficha set fonte_id = $2 where fonte_id = $1", [
        f.fonteId,
        destinoId,
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await visivelParaOAplicativo(f.fonteId)).toBe(1);
  });

  it("item com id que não bate com o tipo e a ordem é recusado", async () => {
    const f = await fichaVerificada();
    await expect(
      carga.query("update acervo.ficha_item set ordem = 7 where id = $1", [
        `${f.slug}/argumento-1`,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("item com página numérica E em texto é recusado (o texto não entraria no hash)", async () => {
    const f = await fichaVerificada();
    await expect(
      carga.query("update acervo.ficha_item set pagina_texto = 'xi' where id = $1", [
        `${f.slug}/argumento-1`,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe.skipIf(emNeon())("a migração 0018 é idempotente", () => {
  it("aplicada de novo, sem erro e sem mudar nenhum hash nem a visibilidade", async () => {
    const f = await fichaVerificada();
    const hashAntes = await hashAtual(f.fonteId);
    const texto = readFileSync(
      path.join(RAIZ, "db", "migrations", "0018_acervo_integridade.sql"),
      "utf8",
    );
    for (let i = 0; i < 2; i++) {
      await migra.query("begin");
      await migra.query(texto);
      await migra.query("commit");
    }
    expect(await hashAtual(f.fonteId)).toBe(hashAntes);
    expect(await visivelParaOAplicativo(f.fonteId)).toBe(1);
  });
});
