import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { buscarNoAcervo, consultaDaBusca, POR_PAGINA_BUSCA } from "@/modules/acervo/busca";
import {
  type Derivado,
  type FichaYaml,
  interpretarDerivado,
  interpretarFichaYaml,
  interpretarFonteYaml,
} from "@/modules/acervo/schemas";
import { MARCA_FIM, MARCA_INICIO } from "@/modules/caderno/marcas";
import { dividirTrecho } from "@/modules/caderno/trecho";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { verificarFichaParaTeste } from "../../support/verificar-ficha-teste";

// Busca bilíngue do Acervo (ACER-05, SP-7): uma palavra em português, com ou sem acento, acha a Fonte em inglês
// pelo resumo e pelas palavras-chave em português; a palavra em inglês acha pelo texto; a ficha só é achada
// depois de verificada. Cria Fontes de teste, então usa um banco descartável SÓ deste arquivo e não roda no
// Neon (o bloco de catálogo, só leitura, roda nos dois). A leitura passa pela porta `comAcervo` (papel do
// aplicativo, política de linha valendo); a escrita nasce pelos papéis de carga e do dono do esquema.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let envDoBanco: Record<string, string> = {};
let carga: pg.Client;
let migra: pg.Client;

async function conectar(papel: "carga" | "migra" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

type SecaoDeTeste = {
  slug: string;
  titulo: string;
  resumo?: string;
  palavras?: string[];
  paragrafos: { ref: string; texto: string }[];
};

/** Carrega uma Fonte de texto integral em inglês pelo carregador real, com o YAML e o derivado montados aqui. */
async function carregarFonte(opcoes: {
  slug: string;
  titulo: string;
  nivel: "primaria" | "academica" | "confessional";
  secoes: SecaoDeTeste[];
}): Promise<void> {
  const yaml = [
    `slug: ${opcoes.slug}`,
    `titulo: ${opcoes.titulo}`,
    "autor: Autor de Teste",
    `nivel: ${opcoes.nivel}`,
    "tipo_texto: integral",
    "idioma: en",
    "publicada: true",
    "licenca: dp-anterior-1929",
    "origem_nome: Origem de teste",
    "origem_url: https://exemplo.invalid/origem",
    "secoes:",
    ...opcoes.secoes.flatMap((s) => [
      `  - slug: "${s.slug}"`,
      `    titulo: ${s.titulo}`,
      ...(s.resumo ? [`    resumo_pt: ${JSON.stringify(s.resumo)}`] : []),
      ...(s.palavras ? [`    palavras_chave_pt: ${JSON.stringify(s.palavras)}`] : []),
    ]),
  ].join("\n");
  const derivado: Derivado = interpretarDerivado(
    {
      versao_formato: 1,
      slug: opcoes.slug,
      idioma: "en",
      origem_id: "origem-de-teste",
      origem_sha256: "a".repeat(64),
      gerado_por: "teste de busca",
      secoes: opcoes.secoes.map((s, i) => ({
        slug: s.slug,
        titulo: s.titulo,
        ordem: i + 1,
        paragrafos: s.paragrafos,
      })),
    },
    `${opcoes.slug}.json`,
  );
  await carregarFontes([{ fonte: interpretarFonteYaml(yaml, `${opcoes.slug}.yaml`), derivado }], {
    cliente: carga,
  });
}

const achados = (trecho: string) =>
  dividirTrecho(trecho)
    .filter((p) => p.achado)
    .map((p) => p.texto);

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  envDoBanco = preparado.env;
  Object.assign(process.env, preparado.env);
  carga = await conectar("carga");
  migra = await conectar("migra");

  await carregarFonte({
    slug: "josefo-de-teste",
    titulo: "Antiguidades de Teste",
    nivel: "primaria",
    secoes: [
      {
        slug: "18",
        titulo: "Livro 18",
        resumo:
          "Josefo menciona Jesus, a crucificação sob Pilatos e o grupo dos cristãos, ainda hoje chamados assim.",
        palavras: ["Jesus", "Pilatos", "crucificação"],
        paragrafos: [
          {
            ref: "18.63",
            texto:
              "Now there was about this time Jesus, a wise man, a doer of wonderful works. And when Pilate had condemned him to the cross, those that loved him did not forsake him.",
          },
        ],
      },
      {
        slug: "20",
        titulo: "Livro 20",
        resumo: "Tiago, o irmão de Jesus, e o sumo sacerdote Anano.",
        palavras: ["Tiago", "Anano"],
        paragrafos: [
          {
            ref: "20.200",
            texto:
              "He brought before them the brother of Jesus, whose name was James, and some others.",
          },
        ],
      },
    ],
  });

  // Uma Fonte de outro Nível, com o caractere de marca DENTRO do texto e do resumo (o realce não pode quebrar).
  await carregarFonte({
    slug: "marcas-de-teste",
    titulo: "Obra com marcas",
    nivel: "confessional",
    secoes: [
      {
        slug: "1",
        titulo: "Capítulo 1",
        resumo: `Isto tem ${MARCA_INICIO}falso${MARCA_FIM} realce e a palavra Quimerafoz.`,
        paragrafos: [
          {
            ref: "1.1",
            texto: `Before ${MARCA_INICIO}fake${MARCA_FIM} markers the word Zorbaxian appeared in the text.`,
          },
        ],
      },
    ],
  });
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await migra?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe("o catálogo da busca (só leitura; vale também no Neon)", () => {
  it("as colunas geradas e o índice GIN de cada uma existem", async () => {
    const pool = obterPool();
    const r = await pool.query<{ tabela: string; coluna: string; gin: boolean }>(`
      select c.relname as tabela, a.attname as coluna,
             exists (select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid
                     join pg_am am on am.oid = ic.relam
                     where i.indrelid = c.oid and am.amname = 'gin'
                       and i.indkey::int2[] @> array[a.attnum]) as gin
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and not a.attisdropped
       where c.relnamespace = 'acervo'::regnamespace
         and (c.relname, a.attname) in (('fonte_secao','tsv_pt'), ('fonte_paragrafo','tsv_en'),
                                        ('ficha','tsv_pt'), ('ficha_item','tsv_pt'))
         and a.attgenerated = 's'
       order by 1`);
    expect(r.rows.map((l) => `${l.tabela}.${l.coluna}`)).toEqual([
      "ficha.tsv_pt",
      "ficha_item.tsv_pt",
      "fonte_paragrafo.tsv_en",
      "fonte_secao.tsv_pt",
    ]);
    for (const l of r.rows) expect(l.gin, `${l.tabela}.${l.coluna}`).toBe(true);
  });
});

describe.skipIf(emNeon())("busca bilíngue", () => {
  it("controle positivo: o dado de teste existe (duas Fontes, três seções, três parágrafos)", async () => {
    const n = await migra.query<{ f: number; s: number; p: number }>(
      `select (select count(*) from acervo.fonte)::int as f,
              (select count(*) from acervo.fonte_secao)::int as s,
              (select count(*) from acervo.fonte_paragrafo)::int as p`,
    );
    expect(n.rows[0]).toEqual({ f: 2, s: 3, p: 3 });
  });

  it("'pilatos', 'Pilatos' e 'PILATOS' acham a seção em inglês pelo resumo em português, com a palavra marcada", async () => {
    for (const termo of ["pilatos", "Pilatos", "PILATOS"]) {
      const r = await buscarNoAcervo({ termo });
      expect(r.total, termo).toBe(1);
      const [achado] = r.resultados;
      expect(achado).toMatchObject({
        tipo: "secao",
        modo: "resumo-pt",
        fonteSlug: "josefo-de-teste",
        fonteTitulo: "Antiguidades de Teste",
        nivel: "primaria",
        secaoSlug: "18",
        secaoTitulo: "Livro 18",
        idioma: "pt",
      });
      // O trecho vem do RESUMO em português (não do texto em inglês).
      expect(achado?.trecho).toContain("crucificação");
      expect(achado?.trecho).not.toContain("Pilate");
      expect(achados(achado?.trecho ?? "")).toEqual(["Pilatos"]);
    }
  });

  it("'crucificacao' (sem acento) acha o mesmo resultado e marca a palavra com acento", async () => {
    const r = await buscarNoAcervo({ termo: "crucificacao" });
    expect(r.total).toBe(1);
    expect(r.resultados[0]).toMatchObject({ modo: "resumo-pt", secaoSlug: "18" });
    expect(achados(r.resultados[0]?.trecho ?? "")).toEqual(["crucificação"]);
  });

  it("a palavra só do texto em inglês acha pelo texto, com a referência do parágrafo e o idioma", async () => {
    const r = await buscarNoAcervo({ termo: "wonderful" });
    expect(r.total).toBe(1);
    expect(r.resultados[0]).toMatchObject({
      tipo: "secao",
      modo: "texto-en",
      secaoSlug: "18",
      ref: "18.63",
      idioma: "en",
    });
    expect(achados(r.resultados[0]?.trecho ?? "")).toEqual(["wonderful"]);
    // O trecho vem do TEXTO: tem palavra do parágrafo, que o resumo em português não tem.
    expect(r.resultados[0]?.trecho).toContain("doer");
  });

  it("'Pilate' (o nome em inglês) também acha a seção 18", async () => {
    const r = await buscarNoAcervo({ termo: "Pilate" });
    expect(r.resultados.map((x) => x.secaoSlug)).toContain("18");
  });

  it("controle negativo: uma palavra que não existe em nada devolve zero, e a pergunta só de palavras vazias também", async () => {
    for (const termo of ["zzxqwvbn", "the", "   "]) {
      const r = await buscarNoAcervo({ termo });
      expect(r, termo).toEqual({ resultados: [], total: 0, restante: 0, proximo: null });
    }
  });

  it("termo com aspas, operadores e SQL é só texto: nada quebra e a tabela continua lá", async () => {
    for (const termo of [
      "'; drop table acervo.fonte; --",
      `"Pilatos" or ("x`,
      "pilatos & | ! ( ) :* <->",
      "\\",
      "Pilatos'",
      "%_",
    ]) {
      await expect(buscarNoAcervo({ termo }), termo).resolves.toBeDefined();
    }
    const n = await migra.query("select count(*)::int as n from acervo.fonte");
    expect(n.rows[0].n).toBe(2);
    // Controle positivo do instrumento: a mesma consulta acha o que existe.
    expect((await buscarNoAcervo({ termo: "Pilatos" })).total).toBe(1);
  });

  it("o filtro de Nível exclui o de outro Nível e aceita mais de um", async () => {
    expect((await buscarNoAcervo({ termo: "Pilatos", niveis: ["primaria"] })).total).toBe(1);
    expect((await buscarNoAcervo({ termo: "Pilatos", niveis: ["academica"] })).total).toBe(0);
    expect((await buscarNoAcervo({ termo: "Pilatos", niveis: ["confessional"] })).total).toBe(0);
    expect(
      (await buscarNoAcervo({ termo: "Pilatos", niveis: ["confessional", "primaria"] })).total,
    ).toBe(1);
    expect((await buscarNoAcervo({ termo: "Quimerafoz", niveis: ["primaria"] })).total).toBe(0);
    expect((await buscarNoAcervo({ termo: "Quimerafoz", niveis: ["confessional"] })).total).toBe(1);
    // Sem Nível: todos.
    expect((await buscarNoAcervo({ termo: "Quimerafoz" })).total).toBe(1);
  });

  it("Fonte não publicada nunca aparece (e volta a aparecer quando publicada)", async () => {
    await carga.query("update acervo.fonte set publicada = false where slug = 'josefo-de-teste'");
    try {
      expect((await buscarNoAcervo({ termo: "Pilatos" })).total).toBe(0);
      expect((await buscarNoAcervo({ termo: "wonderful" })).total).toBe(0);
    } finally {
      await carga.query("update acervo.fonte set publicada = true where slug = 'josefo-de-teste'");
    }
    expect((await buscarNoAcervo({ termo: "Pilatos" })).total).toBe(1);
  });

  it("T-02-23: o caractere de marca que já vem no texto da Fonte não quebra o realce", async () => {
    const pt = await buscarNoAcervo({ termo: "quimerafoz" });
    const trechoPt = pt.resultados[0]?.trecho ?? "";
    expect(achados(trechoPt)).toEqual(["Quimerafoz"]);
    // Os marcadores do texto original saíram; sobraram só os do realce (um par).
    expect(trechoPt.split(MARCA_INICIO)).toHaveLength(2);
    expect(trechoPt.split(MARCA_FIM)).toHaveLength(2);
    expect(trechoPt).toContain("falso");

    const en = await buscarNoAcervo({ termo: "Zorbaxian" });
    const trechoEn = en.resultados[0]?.trecho ?? "";
    expect(en.resultados[0]?.modo).toBe("texto-en");
    expect(achados(trechoEn)).toEqual(["Zorbaxian"]);
    expect(trechoEn.split(MARCA_INICIO)).toHaveLength(2);
    expect(trechoEn).toContain("fake");
  });

  it("20 por vez: o restante diz quantos faltam e a página seguinte entrega o resto", async () => {
    expect(POR_PAGINA_BUSCA).toBe(20);
    const fonte = (
      await migra.query<{ id: string }>(
        "select id from acervo.fonte where slug = 'josefo-de-teste'",
      )
    ).rows[0]?.id;
    for (let i = 1; i <= 25; i++) {
      await carga.query(
        `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          `josefo-de-teste/lote-${i}`,
          fonte,
          `lote-${i}`,
          100 + i,
          `Lote ${i}`,
          `Resumo do lote ${i} com a palavra abracadabrante.`,
        ],
      );
    }
    const primeira = await buscarNoAcervo({ termo: "abracadabrante" });
    expect(primeira.total).toBe(25);
    expect(primeira.resultados).toHaveLength(20);
    expect(primeira.restante).toBe(5);
    expect(primeira.proximo).toBe(20);
    const segunda = await buscarNoAcervo({ termo: "abracadabrante", deslocamento: 20 });
    expect(segunda.resultados).toHaveLength(5);
    expect(segunda.restante).toBe(0);
    expect(segunda.proximo).toBeNull();
    // Sem repetir nem pular: as duas páginas juntas têm 25 seções distintas.
    const todas = [...primeira.resultados, ...segunda.resultados].map((x) => x.secaoSlug);
    expect(new Set(todas).size).toBe(25);
    await carga.query("delete from acervo.fonte_secao where id like 'josefo-de-teste/lote-%'");
  });

  it("ts_headline só roda sobre a página: o limite está dentro da porta de candidatos e o realce vem depois", async () => {
    const { sql: texto } = new PgDialect().sqlToQuery(
      consultaDaBusca({ termo: "pilatos", niveis: null, deslocamento: 0 }),
    );
    const porta = texto.indexOf("buscar_candidatos");
    expect(porta).toBeGreaterThan(0);
    const headlines = [...texto.matchAll(/ts_headline/g)].map((m) => m.index ?? -1);
    expect(headlines.length).toBeGreaterThan(0);
    for (const posicao of headlines) expect(posicao).toBeGreaterThan(porta);
    // O limite da página mora no corpo da porta: só `p_limite` linhas saem dela.
    const corpo = (
      await migra.query<{ src: string }>(
        "select prosrc as src from pg_proc where oid = 'acervo.buscar_candidatos(text, text[], integer, integer)'::regprocedure",
      )
    ).rows[0]?.src as string;
    expect(corpo).toContain("pos <= p_desloc + p_limite");
    expect(corpo).not.toContain("ts_headline");
  });

  it("o plano de execução da porta de candidatos usa o índice GIN de cada caminho (português, inglês e ficha)", async () => {
    // Achado do SP-7: lida DIRETO como jnf_app, a tabela tem política de linha e `@@` não é leakproof, então o GIN
    // fica de fora do plano (a migração 0021 explica). A consulta da busca passa pela função `buscar_candidatos`
    // (security definer do dono, sem política); o plano que importa é o do CORPO dela, pedido aqui como o dono
    // pediria: o corpo vira um comando preparado e o plano sai do `explain execute`.
    const corpo = (
      await migra.query<{ src: string }>(
        "select prosrc as src from pg_proc where oid = 'acervo.buscar_candidatos(text, text[], integer, integer)'::regprocedure",
      )
    ).rows[0]?.src as string;
    expect(corpo).toContain("tsv_en");
    const preparado = corpo
      .replaceAll("p_termo", "$1")
      .replaceAll("p_niveis", "$2")
      .replaceAll("p_limite", "$3")
      .replaceAll("p_desloc", "$4");
    await migra.query("begin");
    try {
      // O corpus de teste é minúsculo: sem isto o planejador prefere varrer a tabela. O que se prova é que a
      // consulta TEM caminho pelo índice (a escolha real, com o corpus de verdade, é medida no SP-7).
      await migra.query("set local enable_seqscan = off");
      await migra.query(`prepare plano_busca (text, text[], integer, integer) as ${preparado}`);
      const plano = await migra.query<{ "QUERY PLAN": string }>(
        "explain (costs off) execute plano_busca('pilatos', null, 20, 0)",
      );
      const linhas = plano.rows.map((l) => l["QUERY PLAN"]).join("\n");
      for (const indice of [
        "fonte_secao_tsv_pt_gin",
        "fonte_paragrafo_tsv_en_gin",
        "ficha_tsv_pt_gin",
        "ficha_item_tsv_pt_gin",
      ]) {
        expect(linhas, indice).toContain(indice);
      }
    } finally {
      await migra.query("rollback");
    }
  });

  it("controle do achado: lido direto como jnf_app, o GIN NÃO entra no plano (a política de linha o impede)", async () => {
    const app = await conectar("app");
    try {
      await app.query("begin");
      await app.query("set local enable_seqscan = off");
      const plano = await app.query<{ "QUERY PLAN": string }>(
        "explain (costs off) select id from acervo.fonte_paragrafo where tsv_en @@ websearch_to_tsquery('english', 'wonderful')",
      );
      await app.query("rollback");
      expect(plano.rows.map((l) => l["QUERY PLAN"]).join("\n")).not.toContain(
        "fonte_paragrafo_tsv_en_gin",
      );
      // E o mesmo predicado, lido como o dono (sem política), usa o índice: o instrumento enxerga a diferença.
      await migra.query("begin");
      await migra.query("set local enable_seqscan = off");
      const doDono = await migra.query<{ "QUERY PLAN": string }>(
        "explain (costs off) select id from acervo.fonte_paragrafo where tsv_en @@ websearch_to_tsquery('english', 'wonderful')",
      );
      await migra.query("rollback");
      expect(doDono.rows.map((l) => l["QUERY PLAN"]).join("\n")).toContain(
        "fonte_paragrafo_tsv_en_gin",
      );
    } finally {
      await app.end().catch(() => {});
    }
  });

  it("só jnf_app executa a porta de candidatos: nem a carga, nem o Assistente, nem o público", async () => {
    const r = await migra.query<{ papel: string; pode: boolean }>(
      `select p as papel, has_function_privilege(p, 'acervo.buscar_candidatos(text, text[], integer, integer)', 'execute') as pode
         from unnest(array['jnf_app','jnf_carga','jnf_assistente']) as p`,
    );
    expect(Object.fromEntries(r.rows.map((l) => [l.papel, l.pode]))).toEqual({
      jnf_app: true,
      jnf_carga: false,
      jnf_assistente: false,
    });
    const publico = await migra.query<{ pode: boolean }>(
      `select exists (
         select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where p.oid = 'acervo.buscar_candidatos(text, text[], integer, integer)'::regprocedure
            and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pode`,
    );
    expect(publico.rows[0]?.pode).toBe(false);
    const definer = await migra.query<{ definer: boolean; dono: string }>(
      `select prosecdef as definer, pg_get_userbyid(proowner) as dono from pg_proc
        where oid = 'acervo.buscar_candidatos(text, text[], integer, integer)'::regprocedure`,
    );
    expect(definer.rows[0]).toEqual({ definer: true, dono: "jnf_migra" });
  });
  it("o trecho mostra e marca o acerto onde ele estiver: só nas palavras-chave, só no título, ou em campos diferentes", async () => {
    await carregarFonte({
      slug: "campos-de-teste",
      titulo: "Obra dos campos",
      nivel: "primaria",
      secoes: [
        {
          slug: "pc",
          titulo: "Capítulo sem a palavra",
          resumo:
            "Resumo comprido do capítulo que fala de outra coisa inteira, sem o nome buscado em lugar nenhum do texto do resumo.",
          palavras: ["Albinoide", "Tiago"],
          paragrafos: [{ ref: "9.1", texto: "Plain text without anything relevant." }],
        },
        {
          slug: "ti",
          titulo: "Zenobiano e o seu tempo",
          resumo: "Resumo comum, que não cita o nome do título.",
          palavras: ["outro"],
          paragrafos: [{ ref: "9.2", texto: "Plain text without anything relevant." }],
        },
        {
          slug: "dois",
          titulo: "Capítulo dois",
          resumo: "O resumo cita Quimeronte e só isso.",
          palavras: ["Ostrogodo"],
          paragrafos: [{ ref: "9.3", texto: "Plain text without anything relevant." }],
        },
      ],
    });
    try {
      // Só nas palavras-chave: o resultado volta (a seção casou) e o trecho mostra e marca a palavra.
      const pc = await buscarNoAcervo({ termo: "albinoide" });
      expect(pc.resultados.map((r) => r.secaoSlug)).toEqual(["pc"]);
      expect(achados(pc.resultados[0]?.trecho ?? "")).toEqual(["Albinoide"]);
      // Só no título.
      const ti = await buscarNoAcervo({ termo: "zenobiano" });
      expect(ti.resultados.map((r) => r.secaoSlug)).toEqual(["ti"]);
      expect(achados(ti.resultados[0]?.trecho ?? "")).toEqual(["Zenobiano"]);
      // Em campos diferentes (resumo e palavras-chave) na mesma consulta: as duas palavras marcadas.
      const dois = await buscarNoAcervo({ termo: "quimeronte ostrogodo" });
      expect(dois.resultados.map((r) => r.secaoSlug)).toEqual(["dois"]);
      expect(achados(dois.resultados[0]?.trecho ?? "").sort()).toEqual(["Ostrogodo", "Quimeronte"]);
      // Controle: o acerto no resumo continua marcando o resumo (o trecho não vira só lista de palavras-chave).
      const resumo = await buscarNoAcervo({ termo: "quimeronte" });
      expect(achados(resumo.resultados[0]?.trecho ?? "")).toEqual(["Quimeronte"]);
      expect(resumo.resultados[0]?.trecho).toContain("resumo cita");
      // Controle negativo: sem acerto em nenhum campo, nenhum resultado (e nenhum trecho sem marca).
      expect((await buscarNoAcervo({ termo: "inexistentissimo" })).total).toBe(0);
      // Propriedade: todo resultado devolvido nestas consultas traz ao menos uma palavra marcada.
      for (const termo of ["albinoide", "zenobiano", "quimeronte", "ostrogodo", "tiago"]) {
        const r = await buscarNoAcervo({ termo });
        expect(r.resultados.length, termo).toBeGreaterThan(0);
        for (const x of r.resultados)
          expect(achados(x.trecho).length, `${termo}: ${x.secaoSlug}`).toBeGreaterThan(0);
      }
    } finally {
      await migra.query(
        "delete from acervo.fonte_paragrafo where secao_id like 'campos-de-teste/%'",
      );
      await migra.query("delete from acervo.fonte_secao where id like 'campos-de-teste/%'");
      await migra.query("delete from acervo.fonte where slug = 'campos-de-teste'");
    }
  });
});

describe.skipIf(emNeon())("busca na ficha", () => {
  const yamlDaFicha = readFileSync(
    path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas", "obra-de-teste.yaml"),
    "utf8",
  );
  let ficha: FichaYaml;

  it("ficha em rascunho não é achada; verificada, é achada com modo 'ficha' pela tese e pelo item", async () => {
    ficha = interpretarFichaYaml(yamlDaFicha, "obra-de-teste.yaml");
    await carregarRascunhos([ficha], { cliente: carga });
    // Controle positivo: a ficha existe no banco e o texto buscado está nela.
    const n = await migra.query<{ n: number }>(
      "select count(*)::int as n from acervo.ficha where tese_pt like '%carregador%'",
    );
    expect(n.rows[0]?.n).toBe(1);

    expect((await buscarNoAcervo({ termo: "carregador" })).total).toBe(0);
    expect((await buscarNoAcervo({ termo: "argumento" })).total).toBe(0);

    await verificarFichaParaTeste(envDoBanco, "obra-de-teste");

    const pelaTese = await buscarNoAcervo({ termo: "carregador" });
    expect(pelaTese.total).toBe(1);
    expect(pelaTese.resultados[0]).toMatchObject({
      tipo: "ficha",
      modo: "ficha",
      fonteSlug: "obra-de-teste",
      fonteTitulo: "Obra de Teste",
      secaoSlug: null,
      idioma: "pt",
    });
    expect(achados(pelaTese.resultados[0]?.trecho ?? "")).toEqual(["carregador"]);

    const peloItem = await buscarNoAcervo({ termo: "argumento" });
    expect(peloItem.total).toBe(1);
    expect(peloItem.resultados[0]).toMatchObject({ tipo: "ficha", modo: "ficha" });
    expect(achados(peloItem.resultados[0]?.trecho ?? "").length).toBeGreaterThan(0);
  });

  it("a ficha alterada depois de verificada volta a ser rascunho e some da busca", async () => {
    await carga.query(
      "update acervo.ficha set tese_pt = tese_pt || ' Acrescentado.' where fonte_id = (select id from acervo.fonte where slug = 'obra-de-teste')",
    );
    expect((await buscarNoAcervo({ termo: "carregador" })).total).toBe(0);
    expect((await buscarNoAcervo({ termo: "argumento" })).total).toBe(0);
  });
});
