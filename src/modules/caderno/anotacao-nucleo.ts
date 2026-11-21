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
// Anotação aberta". A versão só cresce: apagar o texto guarda a linha com o corpo vazio (0014), então a
// mesma versão nunca volta a valer para outro texto.
//
// QUEM escreve e EM QUE ORDEM (0014): cada montagem do editor é um escritor com um id (`montagem`) e um
// número de envio que só cresce (`seq`). A linha guarda o último escritor e o número do envio dele. Três
// regras, e só elas:
//  1. Envio de um escritor com número igual ou menor que o último gravado DELE é velho: recusado.
//  2. Envio de um escritor que é o último que gravou continua o que ele mesmo gravou: aceito mesmo com a base
//     velha (a resposta do envio anterior se perdeu, e ele não tem como saber se gravou).
//  3. Qualquer outro envio só grava sobre a base que a tela mostrava; senão é o conflito, com o que o servidor
//     tem. Texto igual ao do servidor não é conflito (nada a decidir).
// O navegador nunca adivinha se um envio chegou: manda o estado de agora com o número seguinte, e o servidor
// ordena.

type Porta = typeof comEstudante;
export type Opcoes = { porta?: Porta };

export type AnotacaoDoEstudo = { id: string; corpo: string; versao: number; atualizadoEm: string };

export type EntradaDeSalvar = {
  estudoId: string;
  corpo: string;
  /** 0 e `baseId` nulo: a tela não mostrava Anotação. */
  versaoBase: number;
  baseId: string | null;
  /** O escritor (a montagem do editor) e o número deste envio, que só cresce para o mesmo escritor. */
  montagem: string;
  seq: number;
};

export type ResultadoDeSalvar =
  /** O que ficou gravado (corpo vazio: a Anotação apagada, cuja linha fica para guardar a ordem). */
  | { ok: true; anotacao: AnotacaoDoEstudo }
  /** `conta`: o que o servidor tem agora. `id` nulo e versão 0: não há linha. */
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
  montagem: anotacao.montagem,
  seq: anotacao.seq,
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

/** A Anotação do Estudante neste Estudo (corpo vazio: apagada), ou `null` se nunca houve escrita. */
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
 * Guarda o texto da Anotação pelas três regras do topo. Gravar sempre soma 1 à versão e registra o escritor e
 * o número do envio; texto vazio guarda o corpo vazio. O texto acima de 20 000 caracteres é recusado antes de
 * qualquer consulta.
 */
export async function salvarAnotacaoDoEstudo(
  estudanteId: string,
  entrada: EntradaDeSalvar,
  { porta = comEstudante }: Opcoes = {},
): Promise<ResultadoDeSalvar> {
  if (entrada.corpo.length > ANOTACAO_MAX) return { ok: false, erro: "limite" };
  const corpo = estaVazio(entrada.corpo) ? "" : semNulo(entrada.corpo);

  try {
    return await porta(estudanteId, async (tx): Promise<ResultadoDeSalvar> => {
      await travarProgresso(tx, estudanteId);
      const atual = await lerLinha(tx, estudanteId, entrada.estudoId);
      const desteEscritor = atual !== null && atual.montagem === entrada.montagem;
      const conflito = (): ResultadoDeSalvar => ({
        ok: false,
        erro: "conflito",
        conta: atual
          ? {
              id: atual.id,
              corpo: atual.corpo,
              versao: atual.versao,
              atualizadoEm: atual.atualizadoEm.toISOString(),
            }
          : semConta(),
      });
      // 1. Envio velho deste escritor (chegou depois de um mais novo dele): nunca grava.
      if (desteEscritor && entrada.seq <= atual.seq) return conflito();
      const baseBate = atual
        ? entrada.baseId === atual.id && entrada.versaoBase === atual.versao
        : entrada.baseId === null && entrada.versaoBase === 0;
      // 2 e 3. Nem a base bate nem é a continuação do mesmo escritor.
      if (!baseBate && !desteEscritor) {
        if (atual && atual.corpo === corpo) return { ok: true, anotacao: paraTela(atual) };
        return conflito();
      }
      const ordem = { montagem: entrada.montagem, seq: entrada.seq };
      if (!atual) {
        const [nova] = await tx
          .insert(anotacao)
          .values({
            estudanteId,
            estudoId: entrada.estudoId,
            corpo,
            versao: 1,
            ...ordem,
            atualizadoEm: sql`clock_timestamp()`,
          })
          .returning(colunas);
        if (!nova) throw new Error("Anotação não gravada.");
        return { ok: true, anotacao: paraTela(nova) };
      }
      const [nova] = await tx
        .update(anotacao)
        .set({ corpo, versao: atual.versao + 1, ...ordem, atualizadoEm: sql`clock_timestamp()` })
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
