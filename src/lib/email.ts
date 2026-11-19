import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Resend } from "resend";
import { envEmail } from "./env";
import { registrarErro } from "./registro";

// Envio de e-mail. O transporte vem de MAIL_TRANSPORT: `arquivo` grava um JSON por mensagem em
// MAIL_DIR (testes e desenvolvimento); `resend` envia de verdade. Em caso de falha só o código vai
// ao registro: o conteúdo (que traz link e código de acesso) nunca.

export type Mensagem = { para: string; assunto: string; texto: string; html: string };

export async function enviarEmail(mensagem: Mensagem): Promise<boolean> {
  try {
    const env = envEmail();
    if (env.MAIL_TRANSPORT === "arquivo") {
      await mkdir(env.MAIL_DIR, { recursive: true });
      const destino = createHash("sha256").update(mensagem.para).digest("hex").slice(0, 16);
      const nome = `${Date.now()}-${destino}-${randomBytes(4).toString("hex")}.json`;
      await writeFile(join(env.MAIL_DIR, nome), JSON.stringify(mensagem), { mode: 0o600 });
      return true;
    }
    const resultado = await new Resend(env.RESEND_API_KEY).emails.send({
      from: env.EMAIL_FROM ?? "",
      to: mensagem.para,
      subject: mensagem.assunto,
      text: mensagem.texto,
      html: mensagem.html,
    });
    if (resultado.error) {
      registrarErro("email", { code: resultado.error.name });
      return false;
    }
    return true;
  } catch (erro) {
    registrarErro("email", erro);
    return false;
  }
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (caractere) => ESCAPES[caractere] ?? caractere);
}

const ESTILO =
  'style="font-family: Georgia, serif; font-size: 16px; line-height: 1.5; color: #1A1A1A;"';

export const ASSUNTO_ENTRADA = "Seu acesso ao Jesus nas Fontes";
export const ASSUNTO_CONVITE = "Convite para o Jesus nas Fontes";

// Um e-mail só, com o link de confirmação (da nossa página) e o código de 6 dígitos.
export function modeloEntrada(dados: {
  para: string;
  urlConfirmar: string;
  codigo: string;
}): Mensagem {
  const { urlConfirmar, codigo } = dados;
  const texto = [
    "Para entrar no Jesus nas Fontes, abra este link e toque em Entrar:",
    "",
    urlConfirmar,
    "",
    `Se preferir, digite este código de 6 dígitos na tela de entrada: ${codigo}`,
    "",
    "O link vale por 15 minutos e o código por 10. Se você não pediu este acesso, ignore esta mensagem.",
    "Não responda a este e-mail: ninguém lê as respostas.",
  ].join("\n");
  const url = escaparHtml(urlConfirmar);
  const html = `<div ${ESTILO}><p>Para entrar no Jesus nas Fontes, abra o link abaixo e toque em Entrar:</p><p><a href="${url}">${url}</a></p><p>Se preferir, digite este código de 6 dígitos na tela de entrada: <strong>${escaparHtml(codigo)}</strong></p><p>O link vale por 15 minutos e o código por 10. Se você não pediu este acesso, ignore esta mensagem.</p><p>Não responda a este e-mail: ninguém lê as respostas.</p></div>`;
  return { para: dados.para, assunto: ASSUNTO_ENTRADA, texto, html };
}

// Convite: traz só o endereço do site e a instrução de pedir o acesso. Nenhum link de entrada.
export function modeloConvite(dados: { para: string; urlEntrar: string }): Mensagem {
  const texto = [
    "Você foi convidado para o Jesus nas Fontes, um grupo fechado de estudo.",
    "",
    `Para entrar, abra ${dados.urlEntrar}, digite este mesmo e-mail e toque em Enviar acesso. Você receberá um segundo e-mail com o link de entrada.`,
    "",
    "Não responda a este e-mail: ninguém lê as respostas.",
  ].join("\n");
  const url = escaparHtml(dados.urlEntrar);
  const html = `<div ${ESTILO}><p>Você foi convidado para o Jesus nas Fontes, um grupo fechado de estudo.</p><p>Para entrar, abra <a href="${url}">${url}</a>, digite este mesmo e-mail e toque em Enviar acesso. Você receberá um segundo e-mail com o link de entrada.</p><p>Não responda a este e-mail: ninguém lê as respostas.</p></div>`;
  return { para: dados.para, assunto: ASSUNTO_CONVITE, texto, html };
}
