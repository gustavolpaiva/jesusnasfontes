"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { obterDb } from "@/db/cliente";
import { sessao, verificacao } from "@/db/schema/entrada";
import { obterAuth } from "@/lib/auth";
import { registrarErro } from "@/lib/registro";
import { darAcesso } from "./acesso";
import { aceitarConvite, apagarCodigoDe, conviteAtivo } from "./convite";
import { chaveDe, consumirLimite, ipDe, LIMITES, reservarPalpite, zerarLimite } from "./limite";
import { lerEmail } from "./normalizar-email";

// A porta única de entrada. Server Actions: o que o navegador consegue chamar.

export type EstadoEntrada =
  | { etapa: "email"; emailDigitado: string; erro?: "vazio" | "malformado" | "limite" | "falha" }
  | { etapa: "verifique"; emailDigitado: string; email: string };

export type ResultadoCodigo = {
  codigoDigitado: string;
  resultado?: "codigo-invalido" | "limite" | "falha";
};

export type ResultadoReenvio = { rodada: number; resultado?: "reenviado" | "limite" | "falha" };

export async function pedirEntrada(
  _anterior: EstadoEntrada,
  formData: FormData,
): Promise<EstadoEntrada> {
  const digitado = String(formData.get("email") ?? "").trim();
  if (digitado === "") return { etapa: "email", emailDigitado: "", erro: "vazio" };
  const email = lerEmail(digitado);
  if (!email) return { etapa: "email", emailDigitado: digitado, erro: "malformado" };
  try {
    if (!(await pedidoPermitido(email))) {
      return { etapa: "email", emailDigitado: digitado, erro: "limite" };
    }
    await darAcesso(email, await headers());
  } catch (erro) {
    registrarErro("pedir-entrada", erro);
    return { etapa: "email", emailDigitado: digitado, erro: "falha" };
  }
  return { etapa: "verifique", emailDigitado: digitado, email };
}

const chaveFalhasDoCodigo = (email: string) => chaveDe("codigo-falhas", email);

// Pedir acesso conta nos dois limites (IP e e-mail), igual para convidado ou não. Pedido novo NÃO
// zera as falhas de código: senão cada pedido daria palpites novos a quem só sabe o e-mail.
async function pedidoPermitido(email: string): Promise<boolean> {
  const ip = ipDe(await headers());
  const porIp = await consumirLimite(
    chaveDe("pedido-ip", ip),
    LIMITES.pedidoPorIp.maximo,
    LIMITES.pedidoPorIp.janela,
  );
  const porEmail = await consumirLimite(
    chaveDe("pedido-email", email),
    LIMITES.pedidoPorEmail.maximo,
    LIMITES.pedidoPorEmail.janela,
  );
  return porIp.permitido && porEmail.permitido;
}

// Mesmo caminho do primeiro pedido; responde com a mensagem do contrato.
export async function reenviarAcesso(
  anterior: ResultadoReenvio,
  formData: FormData,
): Promise<ResultadoReenvio> {
  const rodada = anterior.rodada + 1;
  const email = lerEmail(formData.get("email"));
  if (!email) return { rodada, resultado: "falha" };
  try {
    if (!(await pedidoPermitido(email))) return { rodada, resultado: "limite" };
    await darAcesso(email, await headers());
  } catch (erro) {
    registrarErro("reenviar-acesso", erro);
    return { rodada, resultado: "falha" };
  }
  return { rodada, resultado: "reenviado" };
}

// Entrar com o código de 6 dígitos. A mensagem de erro é a mesma para endereço convidado ou não:
// as falhas são contadas por nós, por endereço, sem consultar se há convite.
export async function entrarComCodigo(
  _anterior: ResultadoCodigo,
  formData: FormData,
): Promise<ResultadoCodigo> {
  const codigo = String(formData.get("codigo") ?? "").replace(/\s/g, "");
  const email = lerEmail(formData.get("email"));
  const base = { codigoDigitado: codigo };
  if (!email || !/^\d{6}$/.test(codigo)) return { ...base, resultado: "codigo-invalido" };
  try {
    const porIp = await consumirLimite(
      chaveDe("codigo-ip", ipDe(await headers())),
      LIMITES.codigoPorIp.maximo,
      LIMITES.codigoPorIp.janela,
    );
    if (!porIp.permitido) return { ...base, resultado: "limite" };

    const chave = chaveFalhasDoCodigo(email);
    // A tentativa é reservada ANTES da comparação, atomicamente: com várias requisições
    // simultâneas, só (teto − falhas atuais) chegam a comparar. Teto atingido: o caminho do código
    // fecha para o endereço (o link segue valendo), com a mesma resposta de um código errado.
    const reserva = await reservarPalpite(chave);
    if (!reserva.concedido) return { ...base, resultado: "codigo-invalido" };
    let usuarioEmail: string | undefined;
    let resposta: unknown;
    try {
      resposta = await obterAuth().api.signInEmailOTP({
        body: { email, otp: codigo },
        headers: await headers(),
      });
      usuarioEmail = (resposta as { user?: { email?: string } } | null)?.user?.email;
    } catch {
      // No último palpite do teto, o código atual morre (só ele; os links pendentes ficam).
      if (reserva.ultimo) await apagarCodigoDe(email);
      return { ...base, resultado: "codigo-invalido" };
    }
    if (usuarioEmail && (await conviteAtivo(usuarioEmail))) {
      await aceitarConvite(usuarioEmail);
      await zerarLimite(chave);
    } else {
      await revogarSessaoCriada(resposta);
      return { ...base, resultado: "codigo-invalido" };
    }
  } catch (erro) {
    registrarErro("entrar-com-codigo", erro);
    return { ...base, resultado: "falha" };
  }
  redirect("/trilhas");
}

// Só o POST do botão consome o link (o GET da página apenas mostra a tela).
export async function confirmarEntrada(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  let destino = "/entrar/confirmar?invalido=1";
  if (token !== "" && token.length <= 128) {
    try {
      const resposta = await obterAuth().api.magicLinkVerify({
        query: { token },
        headers: await headers(),
      });
      const email = (resposta as { user?: { email?: string } } | null)?.user?.email;
      if (email) {
        if (await conviteAtivo(email)) {
          await aceitarConvite(email);
          destino = "/trilhas";
        } else {
          // Segunda linha (o gancho de criação já deveria ter impedido): desfaz exatamente a
          // sessão que a chamada devolveu, nunca a do navegador de quem fez a requisição.
          await revogarSessaoCriada(resposta);
        }
      }
    } catch (erro) {
      // Link inválido, vencido ou usado: a biblioteca lança; a tela é uma só para os três.
      if (!(erro instanceof Error) || erro.name !== "APIError")
        registrarErro("confirmar-entrada", erro);
    }
  }
  redirect(destino);
}

// Remove a sessão que a própria chamada de entrada devolveu (pelo token dela).
async function revogarSessaoCriada(resposta: unknown): Promise<void> {
  const token = (resposta as { token?: string } | null)?.token;
  if (token) await obterDb().delete(sessao).where(eq(sessao.token, token));
}

export async function sair(): Promise<void> {
  try {
    await obterAuth().api.signOut({ headers: await headers() });
  } catch (erro) {
    registrarErro("sair", erro);
  }
  redirect("/entrar?saiu=1");
}
