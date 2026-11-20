"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { registrarErro } from "@/lib/registro";
import { ConviteDuplicado, convidar } from "@/modules/identidade/convite";
import { lerEmail } from "@/modules/identidade/normalizar-email";
import { exigirAdmin } from "@/modules/identidade/sessao";
import { reenviarConviteNucleo, revogarConviteNucleo } from "./operacoes";

// As três ações da tela de convites. Cada uma confere `exigirAdmin()` ANTES de qualquer outra coisa:
// o layout não roda em toda ação, e uma Server Action é um endereço que qualquer pessoa pode chamar.
// Quem não é Admin recebe a 404; sem sessão, a entrada; sem segundo fator, a tela dele.

export type ResultadoDeAcao =
  | { ok: true; tipo: "convidado" | "reenviado" | "revogado"; email: string; emailSaiu: boolean }
  | {
      ok: false;
      erro:
        | "malformado"
        | "duplicado"
        | "limite"
        | "inexistente"
        | "estado"
        | "proprio"
        | "unico-admin"
        | "servidor";
    };

const TELA = "/admin/convites";
const idDoConvite = z.uuid();

export async function convidarPelaTela(dados: FormData): Promise<ResultadoDeAcao> {
  const sessao = await exigirAdmin();
  const email = lerEmail(dados.get("email"));
  if (!email) return { ok: false, erro: "malformado" };
  try {
    // O mesmo `convidar` do comando `pnpm convidar`: grava convite e conta, e envia o e-mail.
    const { enviado } = await convidar(email, sessao.usuario.id);
    revalidatePath(TELA);
    return { ok: true, tipo: "convidado", email, emailSaiu: enviado };
  } catch (erro) {
    if (erro instanceof ConviteDuplicado) return { ok: false, erro: "duplicado" };
    registrarErro("convidar-pela-tela", erro);
    return { ok: false, erro: "servidor" };
  }
}

export async function reenviarConvite(conviteId: string): Promise<ResultadoDeAcao> {
  await exigirAdmin();
  const id = idDoConvite.safeParse(conviteId);
  if (!id.success) return { ok: false, erro: "inexistente" };
  try {
    const r = await reenviarConviteNucleo(id.data);
    revalidatePath(TELA);
    if (!r.ok) return r;
    return { ok: true, tipo: "reenviado", email: r.email, emailSaiu: r.emailSaiu };
  } catch (erro) {
    registrarErro("reenviar-convite", erro);
    return { ok: false, erro: "servidor" };
  }
}

export async function revogarConvite(conviteId: string): Promise<ResultadoDeAcao> {
  const sessao = await exigirAdmin();
  const id = idDoConvite.safeParse(conviteId);
  if (!id.success) return { ok: false, erro: "inexistente" };
  try {
    const r = await revogarConviteNucleo(id.data, sessao.usuario.id);
    revalidatePath(TELA);
    if (!r.ok) return r;
    return { ok: true, tipo: "revogado", email: r.email, emailSaiu: true };
  } catch (erro) {
    registrarErro("revogar-convite", erro);
    return { ok: false, erro: "servidor" };
  }
}
