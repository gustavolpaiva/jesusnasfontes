import { obterPool } from "./cliente";
import { decidirAmbiente } from "./decidir-ambiente";

export type NomeAmbiente = "dev" | "producao";

export { decidirAmbiente } from "./decidir-ambiente";

// Leitura única por processo do marcador gravado pelo migrar. Sem marcador, falha fechada.
let nomeLido: Promise<string> | undefined;

async function lerNome(): Promise<string> {
  const resultado = await obterPool().query<{ nome: string }>("select nome from acervo.ambiente");
  const nome = resultado.rows[0]?.nome;
  if (resultado.rows.length !== 1 || !nome) {
    throw new Error("Marcador de ambiente ausente no banco: rode as migrações.");
  }
  return nome;
}

export async function conferirAmbiente(): Promise<string> {
  nomeLido ??= lerNome().catch((erro) => {
    nomeLido = undefined; // falha não é memoizada
    throw erro;
  });
  const nome = await nomeLido;
  decidirAmbiente(nome, process.env.VERCEL_ENV);
  return nome;
}
