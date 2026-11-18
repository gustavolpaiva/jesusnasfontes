import { obterPool } from "./cliente";

export type NomeAmbiente = "dev" | "producao";

// Recusa o par errado: banco de produção só na produção da Vercel; qualquer outro ambiente
// (pré-visualização, desenvolvimento ou fora da Vercel) só com banco 'dev'.
export function decidirAmbiente(banco: string, vercelEnv: string | undefined): void {
  const naProducao = vercelEnv === "production";
  if (naProducao && banco !== "producao") {
    throw new Error(
      "Ambiente recusado: a produção da Vercel não pode usar banco de desenvolvimento.",
    );
  }
  if (!naProducao && banco === "producao") {
    throw new Error("Ambiente recusado: banco de produção não pode ser usado fora da produção.");
  }
}

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
