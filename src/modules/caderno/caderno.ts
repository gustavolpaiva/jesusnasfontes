import { sql } from "drizzle-orm";
import { comEstudante } from "@/db/com-estudante";
import { MARCA_FIM, MARCA_INICIO } from "./marcas";

// Caderno (ANOT-03): as Anotações e as Anotações de Sessão da pessoa, a mais recente primeiro, 20 por vez,
// com busca por palavra no servidor (D-08: sem cifra; a busca é do banco). Tudo passa por `comEstudante` (RLS
// forçada): a busca NUNCA devolve texto de outra conta, e o filtro por Estudante é só um cinto.
//
// A busca usa a coluna gerada `tsv` das duas tabelas (`public.pt_unaccent`: ignora acentos e maiúsculas;
// 0001 e 0012). O termo e o cursor vão ao banco por parâmetro, nunca montados em texto de SQL. O texto de
// uma Anotação é privado: nada daqui o põe em log, em erro nem em URL.
//
// O destaque das palavras achadas vem de `ts_headline` com marcadores SENTINELA (dois caracteres da área de
// uso privado, retirados do texto antes): o componente divide o trecho nos marcadores e põe `<mark>` só
// nos pedaços de texto, sem HTML cru. Texto da pessoa nunca entra como HTML.

type Porta = typeof comEstudante;
export type Opcoes = { porta?: Porta };

export const POR_PAGINA = 20;
/** Largura do trecho sem busca (o CSS corta em 3 linhas). */
const TRECHO_SEM_BUSCA = 600;

export type EntradaDoCaderno = {
  /** Única na lista: `anotacao:<id>` ou `sessao:<id>`. */
  chave: string;
  tipo: "anotacao" | "sessao";
  /** Anotação: quando foi atualizada. Sessão: o check-in. ISO. */
  em: string;
  /** Sessão: o check-out. ISO. */
  fimEm: string | null;
  /** Anotação: o Estudo (título e endereço). */
  titulo: string | null;
  slug: string | null;
  /** Sessão: de que Estudo até que Estudo. */
  de: string | null;
  ate: string | null;
  /** O trecho. Na busca traz os marcadores de destaque. */
  trecho: string;
};

export type PaginaDoCaderno = {
  entradas: EntradaDoCaderno[];
  /** Quantas entradas casam com o filtro, no total (não só nesta página). */
  total: number;
  /** Onde a próxima página começa; `null` na última. */
  proximo: string | null;
};

type Linha = {
  tipo: "anotacao" | "sessao";
  id: string;
  em_iso: string;
  em_txt: string;
  fim_iso: string | null;
  titulo: string | null;
  slug: string | null;
  de: string | null;
  ate: string | null;
  trecho: string;
};

// O cursor é o instante com toda a precisão do banco (o `Date` do JavaScript perderia os microssegundos e
// repetiria ou pularia entradas) mais o id. Vem do navegador: é validado antes de ir ao banco.
const FORMATO_DO_CURSOR =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?)\|((?:anotacao|sessao):[0-9a-f-]{36})$/;

export function cursorValido(cursor: string): boolean {
  return FORMATO_DO_CURSOR.test(cursor);
}

/**
 * Uma página do Caderno. Sem `termo`, tudo o que a pessoa escreveu; com `termo`, só o que casa com a palavra
 * (sem acento, sem maiúscula). `cursor` é o `proximo` da página anterior. Erro de banco sobe como erro (o
 * chamador registra só o contexto).
 */
export async function listarCaderno(
  estudanteId: string,
  { termo, cursor }: { termo?: string; cursor?: string | null } = {},
  { porta = comEstudante }: Opcoes = {},
): Promise<PaginaDoCaderno> {
  const alvo = cursor ? FORMATO_DO_CURSOR.exec(cursor) : null;
  if (cursor && !alvo) throw new Error("cursor inválido");

  const consulta = termo ? sql`websearch_to_tsquery('public.pt_unaccent', ${termo})` : null;
  const filtro = consulta ? sql`where tsv @@ ${consulta}` : sql``;
  const depoisDe = alvo
    ? sql`where (em, tipo || ':' || id) < (${alvo[1]}::timestamptz, ${alvo[2]})`
    : sql``;
  const opcoes = `StartSel=${MARCA_INICIO}, StopSel=${MARCA_FIM}, MaxWords=35, MinWords=15, MaxFragments=1`;
  const trecho = consulta
    ? sql`ts_headline('public.pt_unaccent', translate(corpo, E'\\uE000\\uE001', ''), ${consulta}, ${opcoes})`
    : sql`left(corpo, ${TRECHO_SEM_BUSCA})`;

  return porta(
    estudanteId,
    async (tx) => {
      const base = sql`
      with entradas as (
        select 'anotacao'::text as tipo, a.id::text as id, a.atualizado_em as em, null::timestamptz as fim_em,
               e.titulo as titulo, e.slug as slug, null::text as de, null::text as ate,
               a.corpo as corpo, a.tsv as tsv
        from privado.anotacao a
        join conteudo.estudo e on e.id = a.estudo_id
        where a.estudante_id = ${estudanteId}::uuid
        union all
        select 'sessao'::text, s.id::text, s.check_in_em, s.check_out_em,
               null::text, null::text, ei.titulo, coalesce(ef.titulo, ei.titulo),
               s.anotacao, s.tsv
        from privado.sessao s
        join conteudo.estudo ei on ei.id = s.estudo_inicio_id
        left join conteudo.estudo ef on ef.id = s.estudo_fim_id
        where s.estudante_id = ${estudanteId}::uuid
          and s.check_out_em is not null
          and btrim(coalesce(s.anotacao, '')) <> ''
      ), filtradas as (
        select * from entradas ${filtro}
      )`;

      const contagem = await tx.execute<{ n: number }>(
        sql`${base} select count(*)::int as n from filtradas`,
      );
      const total = contagem.rows[0]?.n ?? 0;

      const pagina = await tx.execute<Linha>(sql`
      ${base}
      select tipo, id, em::text as em_txt,
             to_char(em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as em_iso,
             to_char(fim_em at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as fim_iso,
             titulo, slug, de, ate, ${trecho} as trecho
      from (
        select * from filtradas ${depoisDe}
        order by em desc, tipo || ':' || id desc
        limit ${POR_PAGINA + 1}
      ) p
      order by em desc, tipo || ':' || id desc`);

      const linhas = pagina.rows;
      const haMais = linhas.length > POR_PAGINA;
      const visiveis = haMais ? linhas.slice(0, POR_PAGINA) : linhas;
      const ultima = visiveis[visiveis.length - 1];
      return {
        entradas: visiveis.map((l) => ({
          chave: `${l.tipo}:${l.id}`,
          tipo: l.tipo,
          em: l.em_iso,
          fimEm: l.fim_iso,
          titulo: l.titulo,
          slug: l.slug,
          de: l.de,
          ate: l.ate,
          trecho: l.trecho,
        })),
        total,
        proximo: haMais && ultima ? `${ultima.em_txt}|${ultima.tipo}:${ultima.id}` : null,
      };
    },
    { instantaneo: true },
  );
}
