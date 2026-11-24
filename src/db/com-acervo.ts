import { conferirAmbiente } from "./ambiente";
import { obterDb } from "./cliente";
import type { Tx } from "./com-estudante";

// Leituras de acervo e conteudo: transação só de leitura, sem identidade de Estudante.
// `instantaneo: true` lê TUDO no mesmo instantâneo (REPEATABLE READ, só leitura): a leitura que junta várias tabelas
// cuja visibilidade depende de evidência (a ficha, a verificação e os itens) não pode ver uma mudança confirmada no
// meio. A guarda da migração 0019 só recusa ESCRITA fora de READ COMMITTED; leitura em REPEATABLE READ é livre.
export async function comAcervo<T>(
  fn: (tx: Tx) => Promise<T>,
  opcoes: { instantaneo?: boolean } = {},
): Promise<T> {
  await conferirAmbiente();
  return obterDb().transaction(fn, {
    accessMode: "read only",
    ...(opcoes.instantaneo ? { isolationLevel: "repeatable read" as const } : {}),
  });
}
