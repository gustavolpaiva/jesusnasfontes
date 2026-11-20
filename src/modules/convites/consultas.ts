import "server-only";
import { desc } from "drizzle-orm";
import { obterDb } from "@/db/cliente";
import { convite } from "@/db/schema/entrada";
import { exigirAdmin } from "@/modules/identidade/sessao";

export type EstadoDoConvite = "pendente" | "aceito" | "revogado";

export type ConviteListado = {
  id: string;
  email: string;
  estado: EstadoDoConvite;
  criadoEm: Date;
  aceitoEm: Date | null;
  revogadoEm: Date | null;
  // O convite de quem está olhando a lista: sem ações (não dá para se revogar nem se reenviar).
  proprio: boolean;
};

const ESTADOS: readonly string[] = ["pendente", "aceito", "revogado"];

// Lista de convites, do mais recente ao mais antigo. Só Admin com o segundo fator.
export async function listarConvites(): Promise<ConviteListado[]> {
  const sessao = await exigirAdmin();
  const linhas = await obterDb().select().from(convite).orderBy(desc(convite.criadoEm));
  return linhas.map((l) => ({
    id: l.id,
    email: l.emailNorm,
    estado: (ESTADOS.includes(l.estado) ? l.estado : "pendente") as EstadoDoConvite,
    criadoEm: l.criadoEm,
    aceitoEm: l.aceitoEm,
    revogadoEm: l.revogadoEm,
    proprio: l.emailNorm === sessao.usuario.email,
  }));
}
