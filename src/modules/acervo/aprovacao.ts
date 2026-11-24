import { sql } from "drizzle-orm";
import { comAdmin } from "@/db/com-admin";
import type { GrauDeCerteza } from "./estado-da-proposta";

// A única porta que aprova o Grau de uma Afirmação (ACER-06, ACER-10, D-04): chama `acervo.aprovar_afirmacao` (migração
// 0028), que reexige Admin com segundo fator, trava a Afirmação (`FOR UPDATE`), compara os dois hashes que a tela leu
// com os atuais e só então grava. O banco decide; aqui só se repassa, e o erro sobe sanitizado (SQLSTATE) para a ação
// traduzir. Sem diretiva de Server Action: nada daqui é chamável pelo navegador.
export async function aprovarAfirmacao(
  sessaoId: string,
  afirmacaoId: string,
  textoHash: string,
  grau: GrauDeCerteza,
  citacoesHash: string,
): Promise<void> {
  await comAdmin(sessaoId, async (tx) => {
    await tx.execute(
      sql`select acervo.aprovar_afirmacao(${sessaoId}::uuid, ${afirmacaoId}, ${textoHash}, ${grau}, ${citacoesHash})`,
    );
  });
}
