import { desc, eq } from "drizzle-orm";
import { comEstudante } from "@/db/com-estudante";
import { consentimento } from "@/db/schema/consentimento";
import { VERSAO_AVISO } from "./aviso";

// O aceite do aviso (PRIV-01): leitura e gravação só por `comEstudante`, sob a RLS forçada. Este arquivo
// NÃO é de Server Actions (as ações estão em acoes-consentimento.ts): as funções daqui recebem o id do
// Estudante e não podem ser chamáveis pelo navegador.

// A porta é a única entrada para `privado.*`; o parâmetro existe para os testes a trocarem por uma
// montada sobre um pool de uma conexão. O código da aplicação não o passa.
type Porta = typeof comEstudante;

export type Aceite = { versao: string; aceitoEm: Date };

/** O aceite mais recente do Estudante (de qualquer versão), ou `null` se nunca aceitou. */
export async function ultimoAceite(
  estudanteId: string,
  porta: Porta = comEstudante,
): Promise<Aceite | null> {
  const linhas = await porta(estudanteId, (tx) =>
    tx
      .select({ versao: consentimento.versaoAviso, aceitoEm: consentimento.aceitoEm })
      .from(consentimento)
      // O filtro explícito é um cinto; quem protege é a RLS.
      .where(eq(consentimento.estudanteId, estudanteId))
      .orderBy(desc(consentimento.aceitoEm))
      .limit(1),
  );
  return linhas[0] ?? null;
}

/** Existe aceite da versão ATUAL do aviso? */
export async function temConsentimentoAtual(
  estudanteId: string,
  versaoAtual: string = VERSAO_AVISO,
  porta: Porta = comEstudante,
): Promise<boolean> {
  const linhas = await porta(estudanteId, (tx) =>
    tx
      .select({ versao: consentimento.versaoAviso })
      .from(consentimento)
      .where(eq(consentimento.estudanteId, estudanteId))
      .orderBy(desc(consentimento.aceitoEm)),
  );
  return linhas.some((l) => l.versao === versaoAtual);
}

/** Grava o aceite da versão. Repetir (duas abas, duplo toque) não duplica nem muda a data. */
export async function gravarConsentimento(
  estudanteId: string,
  aceite: { versao: string; hash: string },
  porta: Porta = comEstudante,
): Promise<void> {
  await porta(estudanteId, async (tx) => {
    await tx
      .insert(consentimento)
      .values({ estudanteId, versaoAviso: aceite.versao, textoHash: aceite.hash })
      .onConflictDoNothing();
  });
}
