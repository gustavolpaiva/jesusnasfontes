import { sql } from "drizzle-orm";
import { z } from "zod";
import { conferirAmbiente } from "./ambiente";
import { obterDb } from "./cliente";

type Db = ReturnType<typeof obterDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const idDoEstudante = z.uuid();

// Fábrica da porta. O código da aplicação usa `comEstudante` (abaixo); a fábrica existe para os
// testes montarem a mesma porta sobre um pool de tamanho 1.
export function fabricarComEstudante(
  banco: () => Pick<Db, "transaction">,
  conferir: () => Promise<unknown> = conferirAmbiente,
) {
  return async function comEstudante<T>(
    estudanteId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    // Falha antes de qualquer SQL se o id não é um uuid.
    const id = idDoEstudante.parse(estudanteId);
    await conferir();
    return banco().transaction(async (tx) => {
      // O terceiro argumento verdadeiro vale só até o fim desta transação: não vaza para o
      // próximo cliente que receber a mesma conexão do agrupador.
      await tx.execute(sql`select set_config('app.estudante_id', ${id}, true)`);
      return fn(tx);
    });
  };
}

// Única porta para privado.*: nenhum outro caminho do código lê esse esquema.
export const comEstudante = fabricarComEstudante(obterDb);
