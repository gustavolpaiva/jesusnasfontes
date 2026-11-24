import { sql } from "drizzle-orm";
import { z } from "zod";
import { conferirAmbiente } from "./ambiente";
import { obterDb } from "./cliente";

type Db = ReturnType<typeof obterDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const idDoEstudante = z.uuid();

/**
 * `instantaneo: true`: a leitura que monta UMA resposta com mais de uma consulta lê tudo no MESMO instantâneo
 * (REPEATABLE READ, só leitura). Em READ COMMITTED cada consulta vê o que já foi confirmado até ela, e a resposta pode
 * juntar partes de dois estados que nunca existiram juntos. Só para leitura pura: quem trava e depois lê (a fila por
 * Estudante) precisa do READ COMMITTED, em que a consulta depois da trava já enxerga o que a outra aba confirmou.
 */
export type OpcoesDeLeitura = { instantaneo?: boolean };

export function configDeInstantaneo(opcoes: OpcoesDeLeitura) {
  return opcoes.instantaneo
    ? { accessMode: "read only" as const, isolationLevel: "repeatable read" as const }
    : undefined;
}

// Fábrica da porta. O código da aplicação usa `comEstudante` (abaixo); a fábrica existe para os
// testes montarem a mesma porta sobre um pool de tamanho 1.
export function fabricarComEstudante(
  banco: () => Pick<Db, "transaction">,
  conferir: () => Promise<unknown> = conferirAmbiente,
) {
  return async function comEstudante<T>(
    estudanteId: string,
    fn: (tx: Tx) => Promise<T>,
    opcoes: OpcoesDeLeitura = {},
  ): Promise<T> {
    // Falha antes de qualquer SQL se o id não é um uuid.
    const id = idDoEstudante.parse(estudanteId);
    await conferir();
    return banco().transaction(async (tx) => {
      // O terceiro argumento verdadeiro vale só até o fim desta transação: não vaza para o
      // próximo cliente que receber a mesma conexão do agrupador.
      await tx.execute(sql`select set_config('app.estudante_id', ${id}, true)`);
      return fn(tx);
    }, configDeInstantaneo(opcoes));
  };
}

// Única porta para privado.*: nenhum outro caminho do código lê esse esquema.
export const comEstudante = fabricarComEstudante(obterDb);
