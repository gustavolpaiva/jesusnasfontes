// Recusa o par errado: banco de produção só na produção da Vercel; qualquer outro ambiente
// (pré-visualização, desenvolvimento ou fora da Vercel) só com banco 'dev'.
// Função pura, sem importar o cliente: o pool a usa na primeira conexão e `ambiente.ts` a reexporta.
// Mensagem constante, sem dado de consulta: pode atravessar a camada que sanitiza erros de banco.
export class AmbienteRecusado extends Error {
  override name = "AmbienteRecusado";
}

export function decidirAmbiente(banco: string, vercelEnv: string | undefined): void {
  const naProducao = vercelEnv === "production";
  if (naProducao && banco !== "producao") {
    throw new AmbienteRecusado(
      "Ambiente recusado: a produção da Vercel não pode usar banco de desenvolvimento.",
    );
  }
  if (!naProducao && banco === "producao") {
    throw new AmbienteRecusado(
      "Ambiente recusado: banco de produção não pode ser usado fora da produção.",
    );
  }
}
