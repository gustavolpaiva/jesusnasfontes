import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { comEstudante, type Tx } from "@/db/com-estudante";
import { ErroDeBanco } from "@/db/erro-banco";
import { anotacao, anotacaoEscritor } from "@/db/schema/fundacao";
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
// Texto vazio APAGA a linha.
//
// QUEM escreve e EM QUE ORDEM: cada montagem do editor é um escritor com um id (`montagem`) e um número de
// envio que só cresce (`seq`). `privado.anotacao_escritor` (0015) guarda, por escritor e sem Estudo, sem texto e
// sem data, o número do último envio dele que foi processado e, se o último ato dele foi apagar, o id da linha
// que apagou; a linha da Anotação guarda quem a gravou por último. Três regras, e só elas:
//  1. Envio de um escritor com número igual ou menor que o último processado DELE é velho: recusado.
//  2. Envio do escritor que gravou a linha por último (ou que a apagou, se ela não existe mais E nenhum outro
//     escritor da conta escreveu desde então) continua o que ele mesmo fez: aceito mesmo com a base velha (a
//     resposta do envio anterior se perdeu).
//  3. Qualquer outro envio só grava sobre a base que a tela mostrava; senão é o conflito, com o que o servidor
//     tem. Texto igual ao do servidor (inclusive vazio sem linha) não é conflito: nada a decidir.
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
  /** `anotacao` nulo: não há Anotação (o texto era vazio e a linha foi apagada, ou nunca existiu). */
  | { ok: true; anotacao: AnotacaoDoEstudo | null }
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

const conflito = (atual: Awaited<ReturnType<typeof lerLinha>>): ResultadoDeSalvar => ({
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

// A chave estrangeira de `estudo_id` recusou: o Estudo não existe. (A de `estudante_id` é outra: conta apagada.)
function estudoInexistente(erro: unknown): boolean {
  return (
    erro instanceof ErroDeBanco &&
    erro.code === "23503" &&
    (erro.constraint ?? "").includes("estudo_id")
  );
}

/**
 * Guarda o texto da Anotação pelas três regras do topo. Com linha, atualiza e soma 1 à versão; sem linha,
 * insere com versão 1; texto vazio apaga a linha. Todo envio processado (gravado, sem nada a fazer ou em
 * conflito) passa a ser o último daquele escritor. O texto acima de 20 000 caracteres é recusado antes de
 * qualquer consulta.
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
      const [escritor] = await tx
        .select({ seq: anotacaoEscritor.seq, apagou: anotacaoEscritor.apagou })
        .from(anotacaoEscritor)
        .where(
          and(
            eq(anotacaoEscritor.estudanteId, estudanteId),
            eq(anotacaoEscritor.montagem, entrada.montagem),
          ),
        );
      // 1. Envio velho deste escritor (chegou depois de um mais novo dele): nunca grava, nada muda.
      if (escritor && entrada.seq <= escritor.seq) return conflito(atual);

      // Este envio passa a ser o último processado do escritor; `apagou`: o id da linha que ele apagou agora
      // (nulo quando ele gravou texto; sem mudança quando nada foi gravado).
      const registrar = async (apagou?: string | null) => {
        await tx
          .insert(anotacaoEscritor)
          .values({
            estudanteId,
            montagem: entrada.montagem,
            seq: entrada.seq,
            apagou: apagou ?? null,
          })
          .onConflictDoUpdate({
            target: [anotacaoEscritor.estudanteId, anotacaoEscritor.montagem],
            set: { seq: entrada.seq, ...(apagou === undefined ? {} : { apagou }) },
          });
      };
      // Uma escrita deste escritor (gravar ou apagar) tira dos OUTROS escritores da conta a autorização de continuar
      // o que apagaram: depois dela, "a linha que eu apaguei" já não diz que ninguém mexeu. Vale para todos os
      // Estudos da conta (a tabela não sabe o Estudo, de propósito): no pior caso, um conflito a mais, nunca um
      // texto ressuscitado.
      const invalidarOutros = async () => {
        await tx
          .update(anotacaoEscritor)
          .set({ apagou: null })
          .where(
            and(
              eq(anotacaoEscritor.estudanteId, estudanteId),
              ne(anotacaoEscritor.montagem, entrada.montagem),
              isNotNull(anotacaoEscritor.apagou),
            ),
          );
      };

      const baseBate = atual
        ? entrada.baseId === atual.id && entrada.versaoBase === atual.versao
        : entrada.baseId === null && entrada.versaoBase === 0;
      // 2. Continuação: ele gravou a linha por último, ou foi quem a apagou (e a base é a linha que ele apagou).
      const continua = atual
        ? atual.montagem === entrada.montagem
        : escritor?.apagou != null && escritor.apagou === entrada.baseId;
      // 3.
      if (!baseBate && !continua) {
        await registrar();
        const igual = atual ? !vazio && atual.corpo === corpo : vazio;
        if (igual) return { ok: true, anotacao: atual ? paraTela(atual) : null };
        return conflito(atual);
      }

      if (vazio) {
        if (!atual) {
          await registrar();
          return { ok: true, anotacao: null };
        }
        await tx
          .delete(anotacao)
          .where(
            and(
              eq(anotacao.id, atual.id),
              eq(anotacao.estudanteId, estudanteId),
              eq(anotacao.versao, atual.versao),
            ),
          );
        await invalidarOutros();
        await registrar(atual.id);
        return { ok: true, anotacao: null };
      }
      if (!atual) {
        const [nova] = await tx
          .insert(anotacao)
          .values({
            estudanteId,
            estudoId: entrada.estudoId,
            corpo,
            versao: 1,
            montagem: entrada.montagem,
            atualizadoEm: sql`clock_timestamp()`,
          })
          .returning(colunas);
        if (!nova) throw new Error("Anotação não gravada.");
        await invalidarOutros();
        await registrar(null);
        return { ok: true, anotacao: paraTela(nova) };
      }
      const [nova] = await tx
        .update(anotacao)
        .set({
          corpo,
          versao: atual.versao + 1,
          montagem: entrada.montagem,
          atualizadoEm: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(anotacao.id, atual.id),
            eq(anotacao.estudanteId, estudanteId),
            eq(anotacao.versao, atual.versao),
          ),
        )
        .returning(colunas);
      if (!nova) throw new Error("Anotação não atualizada.");
      await invalidarOutros();
      await registrar(null);
      return { ok: true, anotacao: paraTela(nova) };
    });
  } catch (erro) {
    if (estudoInexistente(erro)) return { ok: false, erro: "nao-encontrado" };
    throw erro;
  }
}
