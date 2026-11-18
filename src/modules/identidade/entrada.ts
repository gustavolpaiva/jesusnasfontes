"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { obterDb } from "@/db/cliente";
import { verificacao } from "@/db/schema/entrada";
import { obterAuth } from "@/lib/auth";
import { registrarErro } from "@/lib/registro";
import { aceitarConvite, apagarCodigoDe, conviteAtivo } from "./convite";
import { chaveDe, consumirLimite, ipDe, LIMITES, lerContagem, zerarLimite } from "./limite";
import { lerEmail } from "./normalizar-email";

// A porta única de entrada. Server Actions: o que o navegador consegue chamar.

export type EstadoEntrada =
  | { etapa: "email"; emailDigitado: string; erro?: "vazio" | "malformado" | "limite" | "falha" }
  | { etapa: "verifique"; emailDigitado: string; email: string };

export type ResultadoCodigo = {
  codigoDigitado: string;
  resultado?: "codigo-invalido" | "codigo-esgotado" | "limite" | "falha";
};

export type ResultadoReenvio = { rodada: number; resultado?: "reenviado" | "limite" | "falha" };

class Sentinela extends Error {}

// Para e-mail não convidado: o mesmo volume de trabalho de banco que o convidado dá (a criação do
// registro de link e do código), numa transação que é desfeita. Nada fica gravado e a resposta
// leva o mesmo tempo.
async function trabalhoEquivalente(): Promise<void> {
  try {
    await obterDb().transaction(async (tx) => {
      const expira = new Date(Date.now() + 15 * 60 * 1000);
      await tx.insert(verificacao).values({
        identifier: `equivalente-${crypto.randomUUID()}`,
        value: "x",
        expiresAt: expira,
      });
      await tx.insert(verificacao).values({
        identifier: `equivalente-${crypto.randomUUID()}`,
        value: "x",
        expiresAt: expira,
      });
      throw new Sentinela();
    });
  } catch (erro) {
    if (!(erro instanceof Sentinela)) throw erro;
  }
}

// Decide pelo convite, e só então pede a biblioteca; a resposta é a mesma nos dois casos.
async function darAcesso(email: string): Promise<void> {
  if (await conviteAtivo(email)) {
    await obterAuth().api.signInMagicLink({ body: { email }, headers: await headers() });
  } else {
    await conviteAtivo(email); // mesma consulta que o convidado repete dentro do envio
    await trabalhoEquivalente();
  }
}

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
    await darAcesso(email);
  } catch (erro) {
    registrarErro("pedir-entrada", erro);
    return { etapa: "email", emailDigitado: digitado, erro: "falha" };
  }
  return { etapa: "verifique", emailDigitado: digitado, email };
}

const chaveFalhasDoCodigo = (email: string) => chaveDe("codigo-falhas", email);

// Pedir acesso conta nos dois limites (IP e e-mail), igual para convidado ou não. Um pedido novo
// zera as falhas de código daquele endereço (o código antigo deixa de existir).
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
  if (!porIp.permitido || !porEmail.permitido) return false;
  await zerarLimite(chaveFalhasDoCodigo(email));
  return true;
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
    await darAcesso(email);
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
    const { maximo, janela } = LIMITES.falhasDoCodigo;
    if ((await lerContagem(chave, janela)) >= maximo) {
      return { ...base, resultado: "codigo-esgotado" };
    }
    let usuarioEmail: string | undefined;
    try {
      const resposta = await obterAuth().api.signInEmailOTP({
        body: { email, otp: codigo },
        headers: await headers(),
      });
      usuarioEmail = (resposta as { user?: { email?: string } } | null)?.user?.email;
    } catch {
      const falha = await consumirLimite(chave, maximo, janela);
      if (falha.contagem >= maximo) {
        await apagarCodigoDe(email); // só o código esgotou; os links pendentes ficam
        return { ...base, resultado: "codigo-esgotado" };
      }
      return { ...base, resultado: "codigo-invalido" };
    }
    if (usuarioEmail && (await conviteAtivo(usuarioEmail))) {
      await aceitarConvite(usuarioEmail);
      await zerarLimite(chave);
    } else {
      await obterAuth().api.signOut({ headers: await headers() });
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
          await obterAuth().api.signOut({ headers: await headers() });
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

export async function sair(): Promise<void> {
  try {
    await obterAuth().api.signOut({ headers: await headers() });
  } catch (erro) {
    registrarErro("sair", erro);
  }
  redirect("/entrar?saiu=1");
}
