import type { Idioma, Nivel } from "./schemas";

// Tipos e funções PURAS da Citação no Estudo, sem nada de servidor: o componente de cliente os importa (o arquivo
// `citacoes.ts` puxa o banco, que nunca pode ir para o navegador).

export type Grau = "consenso" | "posicao-majoritaria" | "disputada";

export type PaginaDeCitacao = { inicio: number | null; fim: number | null; texto: string | null };

export type ItemDeCitacao =
  | {
      tipo: "paragrafo";
      /** Chave estável para a lista da tela: o id da Citação no banco. */
      id: string;
      nivel: Nivel;
      autor: string | null;
      obra: string;
      ref: string;
      /** `null`: o trecho não pôde ser mostrado (a tela avisa e mantém o link). */
      trecho: string | null;
      idioma: Idioma;
      /** `/acervo/{slug}/{seção}#p-{ref}` */
      href: string;
    }
  | {
      tipo: "ficha";
      id: string;
      nivel: Nivel;
      obra: string;
      pagina: PaginaDeCitacao;
      trecho: string | null;
      idioma: Idioma;
      /** Quando a ficha foi verificada (ISO). Nunca por quem (D-05). */
      verificadaEm: string;
      href: string;
    }
  | {
      tipo: "passagem";
      id: string;
      nivel: "primaria";
      /** "Lucas 2:7", por extenso. */
      referencia: string;
      edicao: string | null;
      /** `null`: o texto não pôde ser lido (a tela avisa); a Passagem nunca tem link (D-16). */
      versiculos: { numero: number; texto: string }[] | null;
      inicio: number;
      fim: number;
    };

export type CitacaoDaAfirmacao = { grau: Grau; itens: ItemDeCitacao[] };

/** O que o Estudo guarda por Afirmação: `null` = continua "Fonte em preparação" (D-12). */
export type CitacoesPorAfirmacao = Map<string, CitacaoDaAfirmacao>;

/** Do mais direto ao mais interpretado: Fonte primária, Pesquisa acadêmica, Leitura confessional. */
const ORDEM_DO_NIVEL: Record<Nivel, number> = { primaria: 0, academica: 1, confessional: 2 };

/** O Nível que o botão mostra: o mais direto entre as Citações (UI-SPEC tela 8). */
export function nivelMaisDireto(itens: readonly { nivel: Nivel }[]): Nivel {
  let melhor: Nivel = "confessional";
  for (const i of itens) if (ORDEM_DO_NIVEL[i.nivel] < ORDEM_DO_NIVEL[melhor]) melhor = i.nivel;
  return melhor;
}
