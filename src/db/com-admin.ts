import { sql } from "drizzle-orm";
import { z } from "zod";
import { conferirAmbiente } from "./ambiente";
import { obterDb } from "./cliente";
import type { Tx } from "./com-estudante";

type Db = ReturnType<typeof obterDb>;

const idDaSessao = z.uuid();

// Porta do Admin. O banco só deixa ver rascunho de ficha (e a evidência de conferência) quando a
// transação carrega o id de uma sessão de Admin com segundo fator verificado na geração atual da
// conta: a política de linha chama `acervo.exigir_admin_mfa` com o valor de `app.sessao_admin`.
// Um id que não é de sessão de Admin com segundo fator não abre nada (a função devolve nulo).
//
// A transação é de LEITURA E ESCRITA (as funções de verificação do Acervo gravam por dentro dela).
// Fábrica para os testes montarem a mesma porta sobre um pool de tamanho 1.
export function fabricarComAdmin(
  banco: () => Pick<Db, "transaction">,
  conferir: () => Promise<unknown> = conferirAmbiente,
) {
  return async function comAdmin<T>(sessaoId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    // Falha antes de qualquer SQL se o id não é um uuid.
    const id = idDaSessao.parse(sessaoId);
    await conferir();
    return banco().transaction(async (tx) => {
      // Terceiro argumento verdadeiro: vale só até o fim desta transação e não vaza para o próximo
      // cliente que receber a mesma conexão do agrupador.
      await tx.execute(sql`select set_config('app.sessao_admin', ${id}, true)`);
      return fn(tx);
    });
  };
}

export const comAdmin = fabricarComAdmin(obterDb);
