import { type SQL, sql } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { MARCA_FIM, MARCA_INICIO } from "@/modules/caderno/marcas";
import { type Idioma, NIVEIS, type Nivel } from "./schemas";

// Busca bilíngue do Acervo (ACER-05, SP-7). Uma palavra em português, com ou sem acento, acha a Fonte em inglês
// pelo resumo e pelas palavras-chave em português da seção (`fonte_secao.tsv_pt`); a palavra em inglês acha pelo
// texto do parágrafo (`fonte_paragrafo.tsv_en`); e a ficha entra pela tese e pelos itens (`ficha.tsv_pt`,
// `ficha_item.tsv_pt`). Quem decide o que o Estudante enxerga é a política de linha do banco (Fonte de texto
// integral só publicada; ficha só com verificação do conteúdo atual): a consulta roda por `comAcervo` (papel do
// aplicativo) e repete a regra de propósito.
//
// O termo e tudo o mais vão ao banco POR PARÂMETRO; nada é concatenado em texto de SQL. O termo é privado (o que
// alguém procura sobre a fé pode revelar crença): este módulo não o põe em log, em erro nem em URL.
//
// `ts_headline` é caro: roda só sobre as linhas da página final, depois do `limit`. O destaque sai por marcas
// SENTINELA (as do Caderno), retiradas do texto de origem antes; o componente divide o trecho nelas e põe
// `<mark>` só em pedaços de texto. Texto da Fonte nunca vira HTML.

export const POR_PAGINA_BUSCA = 20;
/** Teto do deslocamento: o termo é por palavra, e ninguém pagina além disto. */
const DESLOCAMENTO_MAX = 10_000;

export type ModoDoAcerto = "resumo-pt" | "texto-en" | "ficha";

export type ResultadoDeBusca = {
  tipo: "secao" | "ficha";
  modo: ModoDoAcerto;
  fonteSlug: string;
  fonteTitulo: string;
  nivel: Nivel;
  /** `null` para ficha. */
  secaoSlug: string | null;
  secaoTitulo: string | null;
  /** Referência do parágrafo achado pelo texto em inglês (âncora `#p-<ref>`); `null` nos outros modos. */
  ref: string | null;
  /** Com as marcas de destaque (`caderno/marcas.ts`); dividir com `dividirTrecho`. */
  trecho: string;
  /** Idioma do trecho: o resumo e a ficha são em português, o texto da Fonte é o do parágrafo. */
  idioma: Idioma;
};

export type PaginaDeBusca = {
  resultados: ResultadoDeBusca[];
  /** Quantos resultados casam com o termo e o filtro, no total (não só nesta página). */
  total: number;
  /** Quantos ainda faltam depois desta página. */
  restante: number;
  /** O `deslocamento` da próxima página; `null` na última. */
  proximo: number | null;
};

export type PedidoDeBusca = {
  termo: string;
  /** Lista fechada de Níveis; vazio ou ausente é "todos". */
  niveis?: readonly Nivel[] | null;
  deslocamento?: number;
};

const VAZIA: PaginaDeBusca = { resultados: [], total: 0, restante: 0, proximo: null };
const OPCOES_DO_TRECHO = `StartSel=${MARCA_INICIO}, StopSel=${MARCA_FIM}, MaxWords=35, MinWords=15, MaxFragments=1`;
const MARCAS = `${MARCA_INICIO}${MARCA_FIM}`;

type Linha = {
  total: string | number;
  tipo: "secao" | "ficha";
  modo: ModoDoAcerto;
  fonte_slug: string;
  fonte_titulo: string;
  nivel: string | null;
  secao_slug: string | null;
  secao_titulo: string | null;
  ref: string | null;
  idioma: string | null;
  trecho: string | null;
};

/**
 * A consulta inteira, sem executar. Separada para o teste ler o plano de execução (`EXPLAIN`) da MESMA consulta que a
 * tela roda. `niveis` nulo é "todos"; `termo` já vem limpo.
 */
export function consultaDaBusca({
  termo,
  niveis,
  deslocamento,
}: {
  termo: string;
  niveis: readonly Nivel[] | null;
  deslocamento: number;
}): SQL {
  const lista =
    niveis && niveis.length > 0
      ? sql`array[${sql.join(
          niveis.map((n) => sql`${n}`),
          sql`, `,
        )}]::text[]`
      : sql`null::text[]`;
  // Os candidatos (só identificadores, já na página pedida) vêm pela porta da migração 0021, que usa o índice GIN;
  // o que aparece na tela é lido por junção, como `jnf_app`, então a política de linha vale de novo (as junções
  // internas e o `where` de baixo derrubam o que a política esconde).
  return sql`
    with q as (
      select websearch_to_tsquery('public.pt_unaccent', ${termo}) as pt,
             websearch_to_tsquery('english', ${termo}) as en
    ),
    pagina as (
      select * from acervo.buscar_candidatos(${termo}, ${lista}, ${POR_PAGINA_BUSCA}, ${deslocamento})
    )
    select c.total, c.tipo, c.modo, f.slug as fonte_slug, f.titulo as fonte_titulo, f.nivel,
           s.slug as secao_slug, s.titulo as secao_titulo, par.ref, par.idioma,
           case c.modo
             when 'resumo-pt' then ts_headline('public.pt_unaccent',
               translate(coalesce(nullif(s.resumo_pt, ''), nullif(acervo.juntar_palavras(s.palavras_chave_pt), ''), s.titulo, ''),
                         ${MARCAS}, ''),
               q.pt, ${OPCOES_DO_TRECHO})
             when 'texto-en' then ts_headline('english', translate(par.texto, ${MARCAS}, ''), q.en, ${OPCOES_DO_TRECHO})
             else ts_headline('public.pt_unaccent',
               translate(coalesce(it.texto_pt, fch.tese_pt, ''), ${MARCAS}, ''), q.pt, ${OPCOES_DO_TRECHO})
           end as trecho
      from pagina c
      join acervo.fonte f on f.id = c.fonte_id
      left join acervo.fonte_secao s on s.id = c.secao_id
      left join acervo.fonte_paragrafo par on par.id = c.par_id
      left join acervo.ficha_item it on it.id = c.item_id
      left join acervo.ficha fch on fch.fonte_id = c.fonte_id and c.tipo = 'ficha'
      cross join q
     where (c.tipo = 'ficha' or s.id is not null)
       and (c.modo <> 'texto-en' or par.id is not null)
       and (c.tipo = 'secao' or fch.fonte_id is not null)
     order by c.pos`;
}

function niveisValidos(niveis: PedidoDeBusca["niveis"]): readonly Nivel[] | null | "nenhum" {
  if (!niveis || niveis.length === 0) return null;
  // Lista fechada: valor que não é Nível nunca chega à consulta.
  const validos = NIVEIS.filter((n) => niveis.includes(n));
  return validos.length > 0 ? validos : "nenhum";
}

/**
 * Uma página de resultados da busca. `termo` vazio, só de palavras vazias ("the") ou que nada casa devolve a página
 * vazia (nunca erro). Erro de banco sobe como erro: o chamador registra só o contexto.
 */
export async function buscarNoAcervo({
  termo: bruto,
  niveis,
  deslocamento = 0,
}: PedidoDeBusca): Promise<PaginaDeBusca> {
  const termo = bruto.replaceAll("\u0000", "").trim();
  if (termo === "") return VAZIA;
  const desloc = Number.isInteger(deslocamento)
    ? Math.min(Math.max(deslocamento, 0), DESLOCAMENTO_MAX)
    : 0;
  const filtro = niveisValidos(niveis);
  if (filtro === "nenhum") return VAZIA;

  const consulta = consultaDaBusca({ termo, niveis: filtro, deslocamento: desloc });
  const linhas = await comAcervo(async (tx) => (await tx.execute<Linha>(consulta)).rows);

  const total = Number(linhas[0]?.total ?? 0);
  const resultados: ResultadoDeBusca[] = [];
  for (const l of linhas) {
    resultados.push({
      tipo: l.tipo,
      modo: l.modo,
      fonteSlug: l.fonte_slug,
      fonteTitulo: l.fonte_titulo,
      nivel: l.nivel as Nivel,
      secaoSlug: l.secao_slug,
      secaoTitulo: l.secao_titulo,
      ref: l.modo === "texto-en" ? l.ref : null,
      trecho: l.trecho ?? "",
      // Só o texto da Fonte traz o idioma do parágrafo; o resumo auxiliar e a ficha são em português.
      idioma: l.modo === "texto-en" ? ((l.idioma ?? "en") as Idioma) : "pt",
    });
  }
  const depois = desloc + resultados.length;
  return {
    resultados,
    total,
    restante: Math.max(0, total - depois),
    proximo: depois < total ? depois : null,
  };
}
