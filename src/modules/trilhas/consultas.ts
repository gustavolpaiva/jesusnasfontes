import { and, asc, count, eq, sql } from "drizzle-orm";
import { comAcervo } from "@/db/com-acervo";
import { comEstudante, type Tx } from "@/db/com-estudante";
import { estudo, estudoPassagem, trilha } from "@/db/schema/conteudo";
import { posicao } from "@/db/schema/posicao";
import { conclusao, voltaLeitura } from "@/db/schema/progresso";
import { decompor } from "@/modules/referencias";

// Progresso das Trilhas (TRIL-01, TRIL-04, TRIL-06). O conteúdo (Trilhas e Estudos) vem de `comAcervo`
// e o que é do Estudante (conclusões e volta) só de `comEstudante`: a RLS decide quem vê qual linha.
//
// Volta: só a Leitura contínua tem voltas. Base histórica e Pontos centrais contam sempre na volta 1;
// na Leitura contínua vale a volta atual do Estudante (`privado.volta_leitura`, sem linha = 1).

export const TRILHA_LEITURA_CONTINUA = "leitura-continua";

export type EstudoDaTrilha = {
  id: string;
  slug: string;
  ordem: number;
  titulo: string;
  grupo: string | null;
  /** Número do livro (40 a 43) e capítulo: só preenchidos na Leitura contínua. */
  livro: number | null;
  capitulo: number | null;
  concluido: boolean;
};

export type ResumoDaTrilha = {
  concluidos: number;
  total: number;
  volta: number;
};

export type TrilhaComEstudos = ResumoDaTrilha & {
  id: string;
  nome: string;
  ordem: number;
  descricao: string;
  estudos: EstudoDaTrilha[];
};

// A porta é a única entrada para `privado.*`; o parâmetro existe para os testes a trocarem por uma
// montada sobre um pool de uma conexão. O código da aplicação não o passa.
type Porta = typeof comEstudante;
export type Opcoes = { porta?: Porta };

/** A volta em que o Estudante está na Trilha: sempre 1, salvo na Leitura contínua. */
export async function voltaDaTrilha(
  tx: Tx,
  estudanteId: string,
  trilhaId: string,
): Promise<number> {
  if (trilhaId !== TRILHA_LEITURA_CONTINUA) return 1;
  const linhas = await tx
    .select({ voltaAtual: voltaLeitura.voltaAtual })
    .from(voltaLeitura)
    // O filtro explícito é um cinto; quem protege é a RLS.
    .where(eq(voltaLeitura.estudanteId, estudanteId));
  return linhas[0]?.voltaAtual ?? 1;
}

/** Quantos Estudos da Trilha estão concluídos na volta atual, e o total. Dentro de uma transação. */
export async function resumoDaTrilha(
  tx: Tx,
  estudanteId: string,
  trilhaId: string,
): Promise<ResumoDaTrilha> {
  const volta = await voltaDaTrilha(tx, estudanteId, trilhaId);
  const [totais] = await tx
    .select({ total: count() })
    .from(estudo)
    .where(eq(estudo.trilhaId, trilhaId));
  const [feitos] = await tx
    .select({ concluidos: count() })
    .from(conclusao)
    .innerJoin(estudo, eq(estudo.id, conclusao.estudoId))
    .where(
      and(
        eq(conclusao.estudanteId, estudanteId),
        eq(conclusao.volta, volta),
        eq(estudo.trilhaId, trilhaId),
      ),
    );
  return { concluidos: feitos?.concluidos ?? 0, total: totais?.total ?? 0, volta };
}

/** As três Trilhas em ordem, com os Estudos e o que o Estudante já concluiu (na volta atual). */
export async function listarTrilhas(
  estudanteId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<TrilhaComEstudos[]> {
  const [conteudo, privado] = await Promise.all([
    comAcervo(async (tx) => {
      const trilhas = await tx.select().from(trilha).orderBy(asc(trilha.ordem));
      const estudos = await tx
        .select({
          id: estudo.id,
          slug: estudo.slug,
          trilhaId: estudo.trilhaId,
          ordem: estudo.ordem,
          titulo: estudo.titulo,
          grupo: estudo.grupo,
          livro: estudo.livro,
          capitulo: estudo.capitulo,
          inicio: estudoPassagem.versiculoInicio,
        })
        .from(estudo)
        .leftJoin(
          estudoPassagem,
          and(eq(estudoPassagem.estudoId, estudo.id), eq(estudoPassagem.ordem, 1)),
        )
        .orderBy(asc(estudo.ordem));
      return { trilhas, estudos };
    }),
    porta(estudanteId, async (tx) => {
      const voltas = await tx
        .select({ voltaAtual: voltaLeitura.voltaAtual })
        .from(voltaLeitura)
        .where(eq(voltaLeitura.estudanteId, estudanteId));
      const feitos = await tx
        .select({ estudoId: conclusao.estudoId, volta: conclusao.volta })
        .from(conclusao)
        .where(eq(conclusao.estudanteId, estudanteId));
      return { voltaAtual: voltas[0]?.voltaAtual ?? 1, feitos };
    }),
  ]);

  return conteudo.trilhas.map((t) => {
    const volta = t.id === TRILHA_LEITURA_CONTINUA ? privado.voltaAtual : 1;
    const concluidosNaVolta = new Set(
      privado.feitos.filter((f) => f.volta === volta).map((f) => f.estudoId),
    );
    const estudos: EstudoDaTrilha[] = conteudo.estudos
      .filter((e) => e.trilhaId === t.id)
      .map((e) => {
        // A Leitura contínua tem um capítulo por Estudo: o livro e o capítulo saem da primeira Passagem
        // quando as colunas do Estudo não os trazem.
        const doInicio = e.inicio !== null ? decompor(e.inicio) : null;
        return {
          id: e.id,
          slug: e.slug,
          ordem: e.ordem,
          titulo: e.titulo,
          grupo: e.grupo,
          livro: t.id === TRILHA_LEITURA_CONTINUA ? (e.livro ?? doInicio?.livro ?? null) : null,
          capitulo:
            t.id === TRILHA_LEITURA_CONTINUA ? (e.capitulo ?? doInicio?.capitulo ?? null) : null,
          concluido: concluidosNaVolta.has(e.id),
        };
      });
    return {
      id: t.id,
      nome: t.nome,
      ordem: t.ordem,
      descricao: t.descricao,
      volta,
      total: estudos.length,
      concluidos: estudos.filter((e) => e.concluido).length,
      estudos,
    };
  });
}

/** Se o Estudo está concluído na volta atual da sua Trilha, mais o resumo da Trilha. */
export async function lerEstadoDoEstudo(
  estudanteId: string,
  alvo: { estudoId: string; trilhaId: string },
  { porta = comEstudante }: Opcoes = {},
): Promise<ResumoDaTrilha & { concluido: boolean }> {
  return porta(estudanteId, async (tx) => {
    const resumo = await resumoDaTrilha(tx, estudanteId, alvo.trilhaId);
    const [achado] = await tx
      .select({ n: sql<number>`1` })
      .from(conclusao)
      .where(
        and(
          eq(conclusao.estudanteId, estudanteId),
          eq(conclusao.estudoId, alvo.estudoId),
          eq(conclusao.volta, resumo.volta),
        ),
      );
    return { ...resumo, concluido: achado !== undefined };
  });
}

// ───────────────────────── escritas de progresso (a guarda de sessão fica em progresso.ts) ─────────────────────────

export type EstudoConcluido = ResumoDaTrilha & { trilha: string; slug: string };

async function lerAlvo(tx: Tx, id: string) {
  const [achado] = await tx
    .select({
      id: estudo.id,
      slug: estudo.slug,
      trilhaId: estudo.trilhaId,
      trilhaNome: trilha.nome,
    })
    .from(estudo)
    .innerJoin(trilha, eq(trilha.id, estudo.trilhaId))
    .where(eq(estudo.id, id));
  return achado ?? null;
}

/** Marca o Estudo como concluído na volta atual da Trilha dele. `null` se o Estudo não existe. */
export async function registrarConclusao(
  estudanteId: string,
  estudoId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<EstudoConcluido | null> {
  return porta(estudanteId, async (tx) => {
    const alvo = await lerAlvo(tx, estudoId);
    if (!alvo) return null;
    const volta = await voltaDaTrilha(tx, estudanteId, alvo.trilhaId);
    await tx
      .insert(conclusao)
      .values({ estudanteId, estudoId: alvo.id, volta })
      .onConflictDoNothing();
    const resumo = await resumoDaTrilha(tx, estudanteId, alvo.trilhaId);
    return { ...resumo, trilha: alvo.trilhaNome, slug: alvo.slug };
  });
}

/** Desmarca só a conclusão da volta atual: as das voltas anteriores ficam guardadas. */
export async function removerConclusao(
  estudanteId: string,
  estudoId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<EstudoConcluido | null> {
  return porta(estudanteId, async (tx) => {
    const alvo = await lerAlvo(tx, estudoId);
    if (!alvo) return null;
    const volta = await voltaDaTrilha(tx, estudanteId, alvo.trilhaId);
    await tx
      .delete(conclusao)
      .where(
        and(
          eq(conclusao.estudanteId, estudanteId),
          eq(conclusao.estudoId, alvo.id),
          eq(conclusao.volta, volta),
        ),
      );
    const resumo = await resumoDaTrilha(tx, estudanteId, alvo.trilhaId);
    return { ...resumo, trilha: alvo.trilhaNome, slug: alvo.slug };
  });
}

/**
 * Nova volta da Leitura contínua: só com todas as casas da volta atual concluídas. Nada é apagado; a
 * volta atual sobe de v para v+1 numa só instrução condicional (duas chamadas ao mesmo tempo sobem uma
 * volta só: a segunda não acha a volta v e devolve a que já começou).
 */
export async function iniciarNovaVolta(
  estudanteId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<{ ok: true; volta: number } | { ok: false; erro: "incompleta" }> {
  return porta(estudanteId, async (tx) => {
    const resumo = await resumoDaTrilha(tx, estudanteId, TRILHA_LEITURA_CONTINUA);
    if (resumo.total === 0 || resumo.concluidos < resumo.total) {
      return { ok: false as const, erro: "incompleta" as const };
    }
    const subiu = await tx
      .insert(voltaLeitura)
      .values({ estudanteId, voltaAtual: resumo.volta + 1 })
      .onConflictDoUpdate({
        target: voltaLeitura.estudanteId,
        set: { voltaAtual: resumo.volta + 1, iniciadaEm: sql`now()` },
        setWhere: eq(voltaLeitura.voltaAtual, resumo.volta),
      })
      .returning({ volta: voltaLeitura.voltaAtual });
    const volta =
      subiu[0]?.volta ?? (await voltaDaTrilha(tx, estudanteId, TRILHA_LEITURA_CONTINUA));
    return { ok: true as const, volta };
  });
}

/** O Estudo aberto por último em cada Trilha (id da Trilha para id do Estudo): a casa "atual" da grade. */
export async function lerPosicoesPorTrilha(
  estudanteId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<Map<string, string>> {
  const linhas = await porta(estudanteId, (tx) =>
    tx
      .select({ trilhaId: posicao.trilhaId, estudoId: posicao.estudoId })
      .from(posicao)
      .where(eq(posicao.estudanteId, estudanteId)),
  );
  return new Map(linhas.map((l) => [l.trilhaId, l.estudoId]));
}
