import { and, eq, sql } from "drizzle-orm";
import { comEstudante, type Tx } from "@/db/com-estudante";
import { ErroDeBanco } from "@/db/erro-banco";
import { anotacao } from "@/db/schema/fundacao";
import { travarProgresso } from "@/modules/trilhas/consultas";
import { ANOTACAO_MAX, estaVazio, semNulo } from "./limite";

// Núcleo da Anotação (ANOT-01, ANOT-02): uma por Estudante e por Estudo, privada (RLS forçada, tudo por
// `comEstudante`). Sem Next e sem `'use server'` de propósito: num arquivo `'use server'` toda função
// exportada vira ação chamável pelo navegador, e as Server Actions mesmas (`anotacao.ts`) só validam a
// entrada e chamam este núcleo, que os testes de integração exercitam com uma porta trocada.
//
// O texto é privado: nunca entra em log, em erro nem em URL. Nada aqui o devolve numa mensagem.
//
// FILA: toda escrita pede a MESMA trava por Estudante das escritas de progresso, da Sessão, de exportar e
// de apagar a conta (`travarProgresso`), ANTES de ler o estado. Duas abas salvando juntas: a segunda espera
// a primeira e vê a versão que ela gravou (e, não batendo com a sua base, recebe o conflito). Salvar junto
// de exportar: a exportação traz a Anotação inteira antes ou depois, nunca pela metade. Salvar junto de
// apagar a conta: um espera o outro, na mesma ordem de travas.
//
// QUAL Anotação: a escrita leva o id e a versão do que a tela mostrava (`baseId`, `versaoBase`), nunca "a
// Anotação aberta". Só o número da versão não basta: apagar a Anotação e escrever outra do zero volta a
// versão a 1, e uma aba que ainda mostrava a antiga (id diferente, versão 1) sobrescreveria a nova calada.

type Porta = typeof comEstudante;
export type Opcoes = { porta?: Porta };

export type AnotacaoDoEstudo = { id: string; corpo: string; versao: number; atualizadoEm: string };

export type EntradaDeSalvar = {
  estudoId: string;
  corpo: string;
  /** 0 e `baseId` nulo: a tela não mostrava Anotação. */
  versaoBase: number;
  baseId: string | null;
};

export type ResultadoDeSalvar =
  /** `anotacao` nulo: não há Anotação (o texto era vazio e a linha foi apagada, ou nunca existiu). */
  | { ok: true; anotacao: AnotacaoDoEstudo | null }
  /** `conta`: o que o servidor tem agora. `id` nulo e versão 0: a Anotação foi apagada em outro aparelho. */
  | { ok: false; erro: "conflito"; conta: ContaDoConflito }
  | { ok: false; erro: "limite" | "nao-encontrado" };

export type ContaDoConflito = {
  id: string | null;
  corpo: string;
  versao: number;
  atualizadoEm: string | null;
};

const colunas = {
  id: anotacao.id,
  corpo: anotacao.corpo,
  versao: anotacao.versao,
  atualizadoEm: anotacao.atualizadoEm,
};

const paraTela = (l: {
  id: string;
  corpo: string;
  versao: number;
  atualizadoEm: Date;
}): AnotacaoDoEstudo => ({
  id: l.id,
  corpo: l.corpo,
  versao: l.versao,
  atualizadoEm: l.atualizadoEm.toISOString(),
});

async function lerLinha(tx: Tx, estudanteId: string, estudoId: string) {
  const [linha] = await tx
    .select(colunas)
    .from(anotacao)
    // O filtro explícito é um cinto; quem protege é a RLS.
    .where(and(eq(anotacao.estudanteId, estudanteId), eq(anotacao.estudoId, estudoId)));
  return linha ?? null;
}

/** A Anotação do Estudante neste Estudo, ou `null`. */
export async function lerAnotacaoDoEstudo(
  estudanteId: string,
  estudoId: string,
  { porta = comEstudante }: Opcoes = {},
): Promise<AnotacaoDoEstudo | null> {
  return porta(estudanteId, async (tx) => {
    const linha = await lerLinha(tx, estudanteId, estudoId);
    return linha ? paraTela(linha) : null;
  });
}

const semConta = (): ContaDoConflito => ({ id: null, corpo: "", versao: 0, atualizadoEm: null });

// A chave estrangeira de `estudo_id` recusou: o Estudo não existe. (A de `estudante_id` é outra: conta apagada.)
function estudoInexistente(erro: unknown): boolean {
  return (
    erro instanceof ErroDeBanco &&
    erro.code === "23503" &&
    (erro.constraint ?? "").includes("estudo_id")
  );
}

/**
 * Guarda o texto da Anotação. Com a base batendo (id e versão do que a tela mostrava): sem linha insere com
 * versão 1; com linha atualiza e soma 1; texto vazio apaga a linha. Com a base diferente devolve o conflito
 * com o que o servidor tem e NÃO grava. O texto (acima de 20 000 caracteres) é recusado antes de qualquer
 * consulta. Dois casos que não são conflito: o servidor já tem exatamente este texto (o envio anterior
 * gravou e a resposta se perdeu; reenviar não pode virar conflito) e o texto é vazio e já não há linha.
 */
export async function salvarAnotacaoDoEstudo(
  estudanteId: string,
  entrada: EntradaDeSalvar,
  { porta = comEstudante }: Opcoes = {},
): Promise<ResultadoDeSalvar> {
  if (entrada.corpo.length > ANOTACAO_MAX) return { ok: false, erro: "limite" };
  const corpo = semNulo(entrada.corpo);
  const vazio = estaVazio(corpo);

  try {
    return await porta(estudanteId, async (tx): Promise<ResultadoDeSalvar> => {
      await travarProgresso(tx, estudanteId);
      const atual = await lerLinha(tx, estudanteId, entrada.estudoId);
      const baseVazia = entrada.versaoBase === 0 && entrada.baseId === null;

      if (!atual) {
        // Sem linha: a base tem de ser "nada". Outra coisa é uma Anotação que existia na tela e foi apagada
        // em outro aparelho, e o texto novo não pode ressuscitá-la sem a pessoa ver.
        if (!baseVazia) {
          // Texto vazio e a Anotação já foi apagada: é o que a pessoa queria.
          if (vazio) return { ok: true, anotacao: null };
          return { ok: false, erro: "conflito", conta: semConta() };
        }
        if (vazio) return { ok: true, anotacao: null };
        const [nova] = await tx
          .insert(anotacao)
          .values({
            estudanteId,
            estudoId: entrada.estudoId,
            corpo,
            versao: 1,
            atualizadoEm: sql`clock_timestamp()`,
          })
          .returning(colunas);
        if (!nova) throw new Error("Anotação não gravada.");
        return { ok: true, anotacao: paraTela(nova) };
      }

      const baseBate =
        !baseVazia && entrada.baseId === atual.id && entrada.versaoBase === atual.versao;
      if (!baseBate) {
        // Reenvio do que já está lá: nada a decidir.
        if (!vazio && atual.corpo === corpo) return { ok: true, anotacao: paraTela(atual) };
        return {
          ok: false,
          erro: "conflito",
          conta: {
            id: atual.id,
            corpo: atual.corpo,
            versao: atual.versao,
            atualizadoEm: atual.atualizadoEm.toISOString(),
          },
        };
      }

      if (vazio) {
        await tx
          .delete(anotacao)
          .where(
            and(
              eq(anotacao.id, atual.id),
              eq(anotacao.estudanteId, estudanteId),
              eq(anotacao.versao, atual.versao),
            ),
          );
        return { ok: true, anotacao: null };
      }
      const [nova] = await tx
        .update(anotacao)
        .set({ corpo, versao: atual.versao + 1, atualizadoEm: sql`clock_timestamp()` })
        .where(
          and(
            eq(anotacao.id, atual.id),
            eq(anotacao.estudanteId, estudanteId),
            eq(anotacao.versao, atual.versao),
          ),
        )
        .returning(colunas);
      if (!nova) throw new Error("Anotação não atualizada.");
      return { ok: true, anotacao: paraTela(nova) };
    });
  } catch (erro) {
    if (estudoInexistente(erro)) return { ok: false, erro: "nao-encontrado" };
    throw erro;
  }
}
