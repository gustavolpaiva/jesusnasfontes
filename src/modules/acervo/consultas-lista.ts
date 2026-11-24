import { eq, or } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { ficha } from "@/db/schema/acervo-ficha";
import { fonte } from "@/db/schema/texto";
import { NIVEIS_NA_ORDEM } from "./niveis";
import type { Idioma, Nivel } from "./schemas";

// Lista do Acervo (ACER-01, D-13). Quem decide o que o Estudante enxerga é a política de linha do banco
// (Fonte de texto integral só publicada; Fonte de ficha só com verificação do conteúdo atual); a condição
// da consulta repete a regra de propósito. O Nível pedido NÃO entra na consulta: a consulta devolve tudo o
// que é visível e a seleção por Nível é feita aqui, em memória, sobre a lista fechada.

export type LinhaDaLista = {
  slug: string;
  titulo: string;
  autor: string | null;
  epoca: string | null;
  idioma: Idioma;
  tipo: "integral" | "ficha";
  /** Ano da obra, só para ficha. */
  ano: number | null;
  nivel: Nivel;
};

export type GrupoDaLista = { nivel: Nivel; fontes: LinhaDaLista[] };

export type ListaDoAcervo = {
  /** Grupos na ordem fixa dos Níveis, só os que têm Fonte; com filtro aplicado, só o escolhido. */
  grupos: GrupoDaLista[];
  /** Níveis que têm ao menos uma Fonte visível, com a contagem; só estes viram item do filtro (D-13). */
  oferecidos: { nivel: Nivel; total: number }[];
  /** Total de Fontes visíveis, sem filtro. */
  total: number;
  /** O Nível efetivamente aplicado; `null` quando não há filtro ou quando o pedido não tinha Fonte. */
  nivelAplicado: Nivel | null;
  /** O Nível pedido não tem Fonte: a lista mostra tudo e a tela avisa. */
  nivelSemFonte: boolean;
  /** Total de Fontes no que está sendo mostrado (do filtro, ou todas). */
  totalMostrado: number;
};

const porTitulo = (a: LinhaDaLista, b: LinhaDaLista) => a.titulo.localeCompare(b.titulo, "pt-BR");

/** Organização pura: agrupa, ordena, conta e aplica o filtro sobre a lista fechada de Níveis. */
export function organizarLista(
  linhas: readonly LinhaDaLista[],
  nivelPedido: Nivel | null,
): ListaDoAcervo {
  const porNivel = new Map<Nivel, LinhaDaLista[]>();
  for (const linha of linhas) {
    const lista = porNivel.get(linha.nivel) ?? [];
    lista.push(linha);
    porNivel.set(linha.nivel, lista);
  }
  const todos: GrupoDaLista[] = NIVEIS_NA_ORDEM.flatMap((nivel) => {
    const fontes = porNivel.get(nivel);
    return fontes && fontes.length > 0 ? [{ nivel, fontes: [...fontes].sort(porTitulo) }] : [];
  });
  const oferecidos = todos.map((g) => ({ nivel: g.nivel, total: g.fontes.length }));
  const total = linhas.length;

  const escolhido = nivelPedido ? todos.find((g) => g.nivel === nivelPedido) : undefined;
  return {
    grupos: escolhido ? [escolhido] : todos,
    oferecidos,
    total,
    nivelAplicado: escolhido ? escolhido.nivel : null,
    nivelSemFonte: nivelPedido !== null && !escolhido,
    totalMostrado: escolhido ? escolhido.fontes.length : total,
  };
}

export async function listarFontesPorNivel(nivel: Nivel | null): Promise<ListaDoAcervo> {
  const linhas = await comAcervo(async (tx) =>
    tx
      .select({
        slug: fonte.slug,
        titulo: fonte.titulo,
        autor: fonte.autor,
        epoca: fonte.epoca,
        idioma: fonte.idioma,
        tipo: fonte.tipoTexto,
        ano: ficha.ano,
        nivel: fonte.nivel,
      })
      .from(fonte)
      .leftJoin(ficha, eq(ficha.fonteId, fonte.id))
      // Texto integral só publicado; ficha só quando a política de linha a deixa ver (verificada).
      .where(or(eq(fonte.tipoTexto, "ficha"), eq(fonte.publicada, true))),
  );
  return organizarLista(
    linhas.map((l) => ({
      slug: l.slug,
      titulo: l.titulo,
      autor: l.autor,
      epoca: l.epoca,
      idioma: l.idioma as Idioma,
      tipo: l.tipo === "ficha" ? "ficha" : "integral",
      ano: l.ano,
      nivel: l.nivel as Nivel,
    })),
    nivel,
  );
}
