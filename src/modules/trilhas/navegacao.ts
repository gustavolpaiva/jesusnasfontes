import { asc, eq } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { estudo } from "@/db/schema/conteudo";
import { decompor, LIVROS } from "@/modules/referencias";
import { TRILHA_LEITURA_CONTINUA } from "./consultas";

// Navegação do Estudo: o anterior e o próximo pela ordem da Trilha, e a posição do Estudo nela.
// Nada avança sozinho; estes são só os destinos dos botões "Anterior" e "Próximo".

export type Vizinho = { slug: string; titulo: string };

export type Vizinhanca = {
  anterior: Vizinho | null;
  proximo: Vizinho | null;
  /** Posição do Estudo na Trilha, a partir de 1, e o total de Estudos da Trilha. */
  indice: number;
  total: number;
};

/** Os vizinhos do Estudo na ordem da Trilha dele; `null` se o Estudo não está na Trilha. */
export async function vizinhos(alvo: {
  id: string;
  trilha: { id: string };
}): Promise<Vizinhanca | null> {
  const linhas = await comAcervo((tx) =>
    tx
      .select({ id: estudo.id, slug: estudo.slug, titulo: estudo.titulo })
      .from(estudo)
      .where(eq(estudo.trilhaId, alvo.trilha.id))
      .orderBy(asc(estudo.ordem)),
  );
  const posicao = linhas.findIndex((l) => l.id === alvo.id);
  if (posicao < 0) return null;
  const doIndice = (i: number): Vizinho | null => {
    const l = linhas[i];
    return l ? { slug: l.slug, titulo: l.titulo } : null;
  };
  return {
    anterior: doIndice(posicao - 1),
    proximo: doIndice(posicao + 1),
    indice: posicao + 1,
    total: linhas.length,
  };
}

type EntradaDoEyebrow = {
  trilha: { id: string; nome: string };
  grupo: string | null;
  /** Primeiro versículo da primeira Passagem do Estudo (Leitura contínua: o capítulo). */
  inicioDaPassagem: number | null;
  /** Posição do Estudo na Trilha e total de Estudos dela. */
  indice: number;
  total: number;
  concluido: boolean;
};

/**
 * A linha de cima do Estudo, nas três formas do contrato:
 * "Base histórica · estudo 2 de 8", "Pontos centrais · estudo 5 de 30 · O Sermão do Monte" e
 * "Leitura contínua · Mateus 5 · capítulo 5 de 28"; "· concluído" ao fim quando for o caso.
 */
export function eyebrowDoEstudo(e: EntradaDoEyebrow): string {
  const partes: string[] = [e.trilha.nome];
  const posicao = e.inicioDaPassagem !== null ? decompor(e.inicioDaPassagem) : null;
  const livro = posicao ? LIVROS.find((l) => l.numero === posicao.livro) : undefined;
  if (e.trilha.id === TRILHA_LEITURA_CONTINUA && posicao && livro) {
    partes.push(
      `${livro.nome} ${posicao.capitulo}`,
      `capítulo ${posicao.capitulo} de ${livro.capitulos}`,
    );
  } else {
    partes.push(`estudo ${e.indice} de ${e.total}`);
    if (e.grupo) partes.push(e.grupo);
  }
  if (e.concluido) partes.push("concluído");
  return partes.join(" · ");
}
