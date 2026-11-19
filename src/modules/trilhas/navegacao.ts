import { asc, eq } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { estudo } from "@/db/schema/conteudo";

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
