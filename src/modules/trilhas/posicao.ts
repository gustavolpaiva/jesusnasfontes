import { asc, desc, eq, sql } from "drizzle-orm";
import { comEstudante } from "@/db/com-estudante";
import { estudo, trilha } from "@/db/schema/conteudo";
import { posicao } from "@/db/schema/posicao";

// Posição de leitura (TRIL-05): por Estudante e por Trilha, o último Estudo aberto. É dado privado:
// toda leitura e escrita passa por `comEstudante`, e a RLS do banco decide quem vê qual linha, mesmo
// que um filtro seja esquecido aqui.

// A porta é a única entrada para `privado.*`; o parâmetro existe para os testes a trocarem por uma
// montada sobre um pool de uma conexão (`fabricarComEstudante`). O código da aplicação não o passa.
type Porta = typeof comEstudante;

export type UltimaPosicao = {
  trilhaId: string;
  trilhaNome: string;
  estudoId: string;
  slug: string;
  titulo: string;
  atualizadoEm: Date;
};

/** Grava (ou atualiza) o Estudo aberto na Trilha. Uma linha por Estudante e Trilha. */
export async function registrarPosicao(
  estudanteId: string,
  alvo: { trilhaId: string; estudoId: string },
  porta: Porta = comEstudante,
): Promise<void> {
  await porta(estudanteId, async (tx) => {
    await tx
      .insert(posicao)
      .values({ estudanteId, trilhaId: alvo.trilhaId, estudoId: alvo.estudoId })
      .onConflictDoUpdate({
        target: [posicao.estudanteId, posicao.trilhaId],
        set: { estudoId: alvo.estudoId, atualizadoEm: sql`now()` },
      });
  });
}

/** A posição mais recente entre as Trilhas, com o Estudo para o link, ou `null` se nunca abriu um. */
export async function lerUltimaPosicao(
  estudanteId: string,
  porta: Porta = comEstudante,
): Promise<UltimaPosicao | null> {
  return porta(estudanteId, async (tx) => {
    const linhas = await tx
      .select({
        trilhaId: posicao.trilhaId,
        trilhaNome: trilha.nome,
        estudoId: posicao.estudoId,
        slug: estudo.slug,
        titulo: estudo.titulo,
        atualizadoEm: posicao.atualizadoEm,
      })
      .from(posicao)
      .innerJoin(estudo, eq(estudo.id, posicao.estudoId))
      .innerJoin(trilha, eq(trilha.id, posicao.trilhaId))
      // O filtro explícito é um cinto; quem protege é a RLS (testada sem ele).
      .where(eq(posicao.estudanteId, estudanteId))
      .orderBy(desc(posicao.atualizadoEm), asc(trilha.ordem))
      .limit(1);
    return linhas[0] ?? null;
  });
}
