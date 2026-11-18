import { conferirAmbiente } from "./ambiente";
import { obterDb } from "./cliente";
import type { Tx } from "./com-estudante";

// Leituras de acervo e conteudo: transação só de leitura, sem identidade de Estudante.
export async function comAcervo<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  await conferirAmbiente();
  return obterDb().transaction(fn, { accessMode: "read only" });
}
