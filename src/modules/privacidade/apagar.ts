"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { obterDb } from "@/db/cliente";
import { verificacao } from "@/db/schema/entrada";
import { obterAuth } from "@/lib/auth";
import { enviarEmail, modeloReautenticacao } from "@/lib/email";
import { registrarErro } from "@/lib/registro";
import { manterSoVerificacaoMaisRecente } from "@/modules/identidade/convite";
import { chaveDe, consumirLimite, reservarPalpite } from "@/modules/identidade/limite";
import { exigirSessao } from "@/modules/identidade/sessao";
import { ERRO_UNICO_ADMIN, removerConta } from "./remover-conta";
import { sessaoRecente } from "./sessao-recente";

// Server Actions de apagar a conta (PRIV-03, ANOT-05). Cada uma exige a sessão antes de qualquer coisa
// (e o segundo fator do Admin), mas NÃO o consentimento: quem não aceitou a versão atual do aviso
// também apaga a própria conta (decisão do dono, 20/11/2026). Age só sobre a conta DA SESSÃO, por ID: nada aqui recebe um
// ID, um e-mail ou um filtro vindo do navegador. O pedido forjado de outro site não passa: a checagem de
// origem do Next vale para toda Server Action, e a palavra APAGAR e, com a sessão antiga, o código por
// e-mail só quem tem a conta aberta e a caixa de e-mail consegue dar (T-01-44).

const TIPO_DO_CODIGO = "email-verification" as const;

export type ResultadoPedidoDeCodigo = { ok: true } | { ok: false; erro: "limite" | "falha" };

export type EstadoApagar = {
  erro?: "digitacao" | "codigo" | "limite" | "unico-admin" | "servidor";
  // O servidor decide se o código é necessário (a sessão pode ter envelhecido desde que a tela abriu).
  precisaCodigo?: boolean;
};

async function apagarCodigosDeConfirmacao(email: string): Promise<void> {
  await obterDb()
    .delete(verificacao)
    .where(eq(verificacao.identifier, `${TIPO_DO_CODIGO}-otp-${email}`));
}

/** Envia ao próprio e-mail da conta o código de 6 dígitos da reautenticação (no máximo 3 por 10 min). */
export async function pedirCodigoReautenticacao(): Promise<ResultadoPedidoDeCodigo> {
  const { usuario } = await exigirSessao({ exigirConsentimento: false });
  try {
    const limite = await consumirLimite(chaveDe("apagar-pedido", usuario.id), 3, 600);
    if (!limite.permitido) return { ok: false, erro: "limite" };
    const email = usuario.email.toLowerCase();
    // Um código por vez: o novo invalida o anterior.
    await apagarCodigosDeConfirmacao(email);
    const codigo = await obterAuth().api.createVerificationOTP({
      body: { email, type: TIPO_DO_CODIGO },
    });
    const enviado = await enviarEmail(modeloReautenticacao({ para: email, codigo }));
    return enviado ? { ok: true } : { ok: false, erro: "falha" };
  } catch (erro) {
    registrarErro("pedir-codigo-reautenticacao", erro);
    return { ok: false, erro: "falha" };
  }
}

// Confere o código de 6 dígitos. Os palpites são contados por nós (10 em 24 h por conta) ANTES de
// comparar, e a própria biblioteca mata o código no terceiro erro.
async function codigoConfere(
  usuarioId: string,
  email: string,
  codigo: string,
): Promise<"ok" | "invalido" | "limite"> {
  if (!/^\d{6}$/.test(codigo)) return "invalido";
  const reserva = await reservarPalpite(chaveDe("apagar-palpite", usuarioId));
  if (!reserva.concedido) return "limite";
  try {
    await obterAuth().api.checkVerificationOTP({
      body: { email, type: TIPO_DO_CODIGO, otp: codigo },
      headers: await headers(),
    });
    return "ok";
  } catch {
    // Um palpite errado faz a biblioteca regravar o código; se houve novo pedido no meio, o antigo
    // pode ter voltado. Só o mais recente vale (a mesma regra da entrada por código).
    await manterSoVerificacaoMaisRecente(`${TIPO_DO_CODIGO}-otp-${email}`);
    return "invalido";
  }
}

/** Apaga a conta da sessão depois de APAGAR digitado e, com a sessão antiga, do código por e-mail. */
export async function apagarConta(
  _anterior: EstadoApagar,
  formData: FormData,
): Promise<EstadoApagar> {
  const { usuario, sessao } = await exigirSessao({ exigirConsentimento: false });
  const precisaCodigo = !sessaoRecente(sessao.criadaEm);
  if (String(formData.get("confirmacao") ?? "").trim() !== "APAGAR") {
    return { erro: "digitacao", precisaCodigo };
  }
  const email = usuario.email.toLowerCase();
  try {
    if (precisaCodigo) {
      const codigo = String(formData.get("codigo") ?? "").replace(/\s/g, "");
      const conferencia = await codigoConfere(usuario.id, email, codigo);
      if (conferencia !== "ok") {
        return { erro: conferencia === "limite" ? "limite" : "codigo", precisaCodigo };
      }
    }
    const resultado = await removerConta(usuario.id);
    if (!resultado.ok) {
      return {
        erro: resultado.erro === ERRO_UNICO_ADMIN ? "unico-admin" : "servidor",
        precisaCodigo,
      };
    }
  } catch (erro) {
    registrarErro("apagar-conta", erro);
    return { erro: "servidor", precisaCodigo };
  }
  // A sessão já não existe no banco (a cascata a levou); isto só limpa o cookie deste navegador.
  try {
    await obterAuth().api.signOut({ headers: await headers() });
  } catch {
    // Sessão inexistente: nada a revogar.
  }
  redirect("/entrar?apagada=1");
}
