"use server";

import { redirect } from "next/navigation";
import { registrarErro } from "@/lib/registro";
import { sair } from "@/modules/identidade/entrada";
import { exigirSessao } from "@/modules/identidade/sessao";
import { hashDoAviso, VERSAO_AVISO } from "./aviso";
import { gravarConsentimento } from "./consentimento";

// Server Actions do consentimento (PRIV-01). Ficam fora do portão (`exigirConsentimento: false`):
// são justamente o caminho para consentir ou sair. A sessão continua obrigatória.

export type EstadoConsentimento = {
  erro?: "caixa" | "gravacao" | "sessao-trocada" | "aviso-mudou";
};

/** Concordar e continuar: a caixa é obrigatória; sem ela devolve o erro e nada é gravado. */
export async function aceitarAviso(
  _anterior: EstadoConsentimento,
  formData: FormData,
): Promise<EstadoConsentimento> {
  const { usuario } = await exigirSessao({ exigirConsentimento: false });
  // Consentir é um ato de quem leu: a tela leva o id de quem a abriu e a versão do aviso que mostrou. Se o navegador entrou
  // com outra conta depois (a sessão é um cookie, comum às abas), ou o servidor já tem outra versão, nada é gravado.
  if (String(formData.get("estudanteId") ?? "") !== usuario.id) return { erro: "sessao-trocada" };
  if (String(formData.get("versao") ?? "") !== VERSAO_AVISO) return { erro: "aviso-mudou" };
  if (formData.get("consinto") !== "on") return { erro: "caixa" };
  try {
    await gravarConsentimento(usuario.id, { versao: VERSAO_AVISO, hash: hashDoAviso() });
  } catch (erro) {
    registrarErro("aceitar-aviso", erro);
    return { erro: "gravacao" };
  }
  redirect("/trilhas");
}

/** Não concordo, sair: encerra a sessão sem gravar nada. */
export async function recusarAviso(): Promise<void> {
  await exigirSessao({ exigirConsentimento: false });
  await sair();
}
