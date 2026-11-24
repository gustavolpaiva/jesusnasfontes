import pg from "pg";
import { urlDoPapel } from "../../src/db/url";
import { removerFichas, type SlugsDeFicha, semearFichas } from "./ficha-e2e";
import { criarSessaoDeTeste } from "./sessao-admin-banco";

// Citações de TESTE para o Estudo (plano 02-19). Tudo é sintético: as Citações apontam para o recorte da fixture do Josefo,
// para uma Passagem bíblica e para as fichas INVENTADAS de `ficha-e2e.ts`. NENHUMA aprovação é inserida direto: o ajudante
// insere a Citação como `jnf_carga` (o papel da carga) e aprova SEMPRE pela função real do banco
// (`acervo.aprovar_afirmacao`), com uma sessão de Admin com segundo fator semeada para isto. O que o teste vê é o que a
// produção produz.
//
// Os dois projetos do Playwright (celular e computador) rodam o mesmo arquivo AO MESMO TEMPO no mesmo banco: cada um usa o
// SEU Estudo da Base histórica (sete Afirmações cada) e as suas fichas (sufixo no slug), então nunca disputam uma
// Afirmação. Estudos que outros testes leem (O nascimento, Batismo e tentação) ficam fora.

/** O Estudo de cada projeto: sete Afirmações em cinco blocos, com pares no mesmo bloco (ordinal). */
const ESTUDO_DO_PROJETO: Record<string, string> = {
  celular: "o-mundo-de-jesus",
  computador: "quem-escreveu-e-quando",
};

export const estudoDoProjeto = (projeto: string): string =>
  ESTUDO_DO_PROJETO[projeto] ?? "o-mundo-de-jesus";

/** O papel de cada Afirmação do Estudo, pela ordem do texto. */
export const PAPEIS = [
  "passagem", // Citação de Passagem (Lc 2:7), grau consenso
  "irma", // sem Citação: continua com "Fonte em preparação"; divide o bloco com a anterior
  "paragrafo", // Citação de parágrafo de Fonte (Josefo 18.63), grau posicao-majoritaria
  "ficha", // Citação de item de ficha verificada, grau disputada; divide o bloco com a anterior
  "varias", // as três Citações juntas, grau consenso
  "indisponivel", // Citação cujo trecho não pode ser mostrado (parágrafo com trecho em branco)
  "ficha-rascunho", // Citação de ficha NÃO verificada: a aprovação é recusada e o chip fica
] as const;
export type Papel = (typeof PAPEIS)[number];

export const JOSEFO = {
  paragrafo: "josefo-antiguidades/18.63",
  secao: "18",
  slug: "josefo-antiguidades",
  // O trecho carrega marcação de propósito: tem de aparecer como TEXTO e nunca virar elemento (T-02-52).
  trecho: 'Now there was about this time Jesus, a wise man <img src=x onerror="window.__xss=1">',
  rotulo: "Flávio Josefo, Antiguidades Judaicas, 18.63",
} as const;

export const LUCAS_2_7 = { inicio: 42002007, fim: 42002007 } as const;

export type SemeadoDeCitacao = {
  estudo: string;
  afirmacoes: Record<Papel, string>;
  fichas: SlugsDeFicha;
  sufixoDasFichas: string;
};

async function comCliente<T>(
  papel: "carga" | "app" | "dono",
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const url =
    papel === "dono"
      ? (process.env.DATABASE_URL_OWNER as string)
      : urlDoPapel(papel, { agrupada: false }, process.env);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}

async function afirmacoesDoEstudo(slug: string): Promise<string[]> {
  return comCliente("dono", async (c) => {
    const r = await c.query<{ id: string }>(
      `select a.id from acervo.afirmacao a join conteudo.estudo e on e.id = a.estudo_id
        where e.slug = $1 order by a.ordem`,
      [slug],
    );
    return r.rows.map((l) => l.id);
  });
}

type Grau = "consenso" | "posicao-majoritaria" | "disputada";

/** Aprova pela função REAL do banco, com os hashes que o banco calcula agora (o que o painel do plano 21 fará). */
export async function aprovarPelaFuncao(afirmacao: string, grau: Grau): Promise<void> {
  await comCliente("dono", async (dono) => {
    const { sessaoId } = await criarSessaoDeTeste(dono, "admin-com-segundo-fator");
    await comCliente("app", async (app) => {
      const h = await dono.query<{ texto: string; conjunto: string }>(
        `select a.texto_hash as texto, acervo.hash_citacoes(a.id) as conjunto
           from acervo.afirmacao a where a.id = $1`,
        [afirmacao],
      );
      const l = h.rows[0];
      if (!l) throw new Error(`aprovarPelaFuncao: Afirmação ${afirmacao} não existe`);
      await app.query("select acervo.aprovar_afirmacao($1::uuid, $2, $3, $4, $5)", [
        sessaoId,
        afirmacao,
        l.texto,
        grau,
        l.conjunto,
      ]);
    });
  });
}

/** Tenta aprovar e devolve o código de erro do banco (`null` se gravou): para provar a recusa. */
export async function tentarAprovar(afirmacao: string, grau: Grau): Promise<string | null> {
  try {
    await aprovarPelaFuncao(afirmacao, grau);
    return null;
  } catch (erro) {
    return (erro as { code?: string }).code ?? "erro";
  }
}

type NovaCitacao =
  | { tipo: "paragrafo"; id: string; trecho?: string; idioma?: "pt" | "en" }
  | { tipo: "ficha"; item: string; trecho?: string; idioma?: "pt" | "en" }
  | { tipo: "passagem"; inicio: number; fim: number };

/** Insere as Citações como `jnf_carga`, na ordem dada (a ordem é do banco, `unique (afirmacao, ordem)`). */
export async function inserirCitacoes(afirmacao: string, itens: NovaCitacao[]): Promise<void> {
  await comCliente("carga", async (c) => {
    let ordem = 0;
    for (const i of itens) {
      ordem++;
      if (i.tipo === "paragrafo") {
        await c.query(
          `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
           values ($1, $2, $3, $4, $5)`,
          [afirmacao, i.id, i.trecho ?? null, i.idioma ?? "en", ordem],
        );
      } else if (i.tipo === "ficha") {
        await c.query(
          `insert into acervo.citacao (afirmacao_id, ficha_item_id, trecho, idioma, ordem)
           values ($1, $2, $3, $4, $5)`,
          [afirmacao, i.item, i.trecho ?? null, i.idioma ?? null, ordem],
        );
      } else {
        await c.query(
          `insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem)
           values ($1, $2, $3, $4)`,
          [afirmacao, i.inicio, i.fim, ordem],
        );
      }
    }
  });
}

/**
 * Semeia as Citações do projeto: uma por papel (menos "irma", que fica sem). Devolve os ids das Afirmações por papel.
 * As fichas de teste entram com o sufixo `cit-<projeto>`: nunca colidem com as do spec de ficha.
 */
export async function semearCitacoes(projeto: string): Promise<SemeadoDeCitacao> {
  const estudo = estudoDoProjeto(projeto);
  const ids = await afirmacoesDoEstudo(estudo);
  if (ids.length < PAPEIS.length) {
    throw new Error(
      `semearCitacoes: o Estudo ${estudo} tem ${ids.length} Afirmações, preciso de ${PAPEIS.length}`,
    );
  }
  const afirmacoes = Object.fromEntries(PAPEIS.map((p, i) => [p, ids[i] as string])) as Record<
    Papel,
    string
  >;

  const sufixoDasFichas = `cit-${projeto}`;
  const semeadas = await semearFichas(sufixoDasFichas);
  const fichas = semeadas.slugs;
  const itemVerificado = `${fichas.completa}/argumento-1`;
  const itemRascunho = `${fichas.rascunho}/argumento-1`;

  await inserirCitacoes(afirmacoes.passagem, [{ tipo: "passagem", ...LUCAS_2_7 }]);
  await aprovarPelaFuncao(afirmacoes.passagem, "consenso");

  await inserirCitacoes(afirmacoes.paragrafo, [
    { tipo: "paragrafo", id: JOSEFO.paragrafo, trecho: JOSEFO.trecho, idioma: "en" },
  ]);
  await aprovarPelaFuncao(afirmacoes.paragrafo, "posicao-majoritaria");

  await inserirCitacoes(afirmacoes.ficha, [{ tipo: "ficha", item: itemVerificado }]);
  await aprovarPelaFuncao(afirmacoes.ficha, "disputada");

  await inserirCitacoes(afirmacoes.varias, [
    { tipo: "passagem", ...LUCAS_2_7 },
    { tipo: "paragrafo", id: JOSEFO.paragrafo, trecho: JOSEFO.trecho, idioma: "en" },
    { tipo: "ficha", item: itemVerificado },
  ]);
  await aprovarPelaFuncao(afirmacoes.varias, "consenso");

  // Trecho em branco: a Citação vale (alvo publicado), mas o trecho não pode ser mostrado.
  await inserirCitacoes(afirmacoes.indisponivel, [
    { tipo: "paragrafo", id: JOSEFO.paragrafo, trecho: " ", idioma: "en" },
  ]);
  await aprovarPelaFuncao(afirmacoes.indisponivel, "posicao-majoritaria");

  // Ficha em rascunho: a aprovação é recusada pelo banco (P0003) e a Afirmação continua com "Fonte em preparação".
  await inserirCitacoes(afirmacoes["ficha-rascunho"], [{ tipo: "ficha", item: itemRascunho }]);

  return { estudo, afirmacoes, fichas, sufixoDasFichas };
}

/** Tira o que `semearCitacoes` pôs: aprovações, Citações e fichas de teste (como dono; a aprovação não tem delete para o app). */
export async function removerCitacoes(semeado: SemeadoDeCitacao): Promise<void> {
  const ids = Object.values(semeado.afirmacoes);
  await comCliente("dono", async (c) => {
    await c.query("delete from acervo.aprovacao_afirmacao where afirmacao_id = any($1::text[])", [
      ids,
    ]);
    await c.query("delete from acervo.citacao where afirmacao_id = any($1::text[])", [ids]);
  });
  await removerFichas(semeado.sufixoDasFichas);
}

// ───────────────────────── Estudo com Citação para as varreduras (axe, reflow, teclado, cinza) ─────────────────────────

/** O Estudo da varredura: nenhum outro teste o lê (os Estudos de `ESTUDO_DO_PROJETO` são do spec da Citação). */
export const ESTUDO_DA_VARREDURA = "por-que-quatro-e-por-que-diferem";

/**
 * Semeia, UMA vez por banco, as Citações do Estudo da varredura: uma Afirmação de Passagem, uma de parágrafo, uma de
 * ficha e uma com as três. Idempotente e seguro entre processos (trava de aconselhamento): vários processos de varredura
 * chamam isto e só o primeiro grava. O banco da execução é descartável, então nada precisa ser removido. Devolve o slug.
 */
export async function semearCitacoesDaVarredura(slugDaFichaVerificada: string): Promise<string> {
  await comCliente("dono", async (dono) => {
    await dono.query("select pg_advisory_lock(190219)");
    try {
      const ids = (
        await dono.query<{ id: string }>(
          `select a.id from acervo.afirmacao a join conteudo.estudo e on e.id = a.estudo_id
            where e.slug = $1 order by a.ordem`,
          [ESTUDO_DA_VARREDURA],
        )
      ).rows.map((l) => l.id);
      if (ids.length < 4)
        throw new Error(`o Estudo ${ESTUDO_DA_VARREDURA} tem ${ids.length} Afirmações`);
      const [passagem, paragrafo, ficha, varias] = ids as [string, string, string, string];
      const ja = await dono.query(
        "select 1 from acervo.aprovacao_afirmacao where afirmacao_id = $1",
        [passagem],
      );
      if (ja.rowCount) return;
      const item = `${slugDaFichaVerificada}/argumento-1`;
      await inserirCitacoes(passagem, [{ tipo: "passagem", ...LUCAS_2_7 }]);
      await aprovarPelaFuncao(passagem, "consenso");
      await inserirCitacoes(paragrafo, [
        { tipo: "paragrafo", id: JOSEFO.paragrafo, trecho: JOSEFO.trecho, idioma: "en" },
      ]);
      await aprovarPelaFuncao(paragrafo, "posicao-majoritaria");
      await inserirCitacoes(ficha, [{ tipo: "ficha", item }]);
      await aprovarPelaFuncao(ficha, "disputada");
      await inserirCitacoes(varias, [
        { tipo: "passagem", ...LUCAS_2_7 },
        { tipo: "paragrafo", id: JOSEFO.paragrafo, trecho: JOSEFO.trecho, idioma: "en" },
        { tipo: "ficha", item },
      ]);
      await aprovarPelaFuncao(varias, "consenso");
    } finally {
      await dono.query("select pg_advisory_unlock(190219)");
    }
  });
  return ESTUDO_DA_VARREDURA;
}

/** O Estudo com capitular na primeira Afirmação (Citação de Passagem nela) e Afirmações sem Citação: só a conferência visual usa. */
export const ESTUDO_DA_CAPITULAR = "como-o-texto-chegou-ate-nos";

/** Idempotente e seguro entre processos: põe a Citação de Passagem em `bh05-a1` (a primeira frase, que leva capitular). */
export async function semearCitacaoDaCapitular(): Promise<string> {
  await comCliente("dono", async (dono) => {
    await dono.query("select pg_advisory_lock(190219)");
    try {
      const id = "bh05-a1";
      const ja = await dono.query(
        "select 1 from acervo.aprovacao_afirmacao where afirmacao_id = $1",
        [id],
      );
      if (ja.rowCount) return;
      await inserirCitacoes(id, [{ tipo: "passagem", ...LUCAS_2_7 }]);
      await aprovarPelaFuncao(id, "posicao-majoritaria");
    } finally {
      await dono.query("select pg_advisory_unlock(190219)");
    }
  });
  return ESTUDO_DA_CAPITULAR;
}
