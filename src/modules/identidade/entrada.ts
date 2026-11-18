"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { obterDb } from "@/db/cliente";
import { verificacao } from "@/db/schema/entrada";
import { obterAuth } from "@/lib/auth";
import { registrarErro } from "@/lib/registro";
import { aceitarConvite, conviteAtivo } from "./convite";
import { lerEmail } from "./normalizar-email";

// A porta única de entrada. Server Actions: o que o navegador consegue chamar.

export type EstadoEntrada =
  | { etapa: "email"; emailDigitado: string; erro?: "vazio" | "malformado" | "limite" | "falha" }
  | {
      etapa: "verifique";
      emailDigitado: string;
      email: string;
      // Mensagem de resultado da etapa: código errado, esgotado, limite ou reenvio.
      resultado?: "codigo-invalido" | "codigo-esgotado" | "limite" | "reenviado" | "falha";
    };

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
    await darAcesso(email);
  } catch (erro) {
    registrarErro("pedir-entrada", erro);
    return { etapa: "email", emailDigitado: digitado, erro: "falha" };
  }
  return { etapa: "verifique", emailDigitado: digitado, email };
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
