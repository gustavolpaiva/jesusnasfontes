"use server";

import { cookies } from "next/headers";
import { z } from "zod";
import { COOKIE_ESCALA, COOKIE_TEMA } from "./preferencias";

// Persistem a preferência por aparelho: cookies `tema` e `escala-texto`, SameSite=Lax, um ano.
// A entrada vem do cliente, então é validada (T-01-20) antes de virar cookie.
const UM_ANO = 60 * 60 * 24 * 365;

const opcoes = () => ({
  path: "/",
  sameSite: "lax" as const,
  maxAge: UM_ANO,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
});

const esquemaTema = z.enum(["aparelho", "claro", "escuro"]);
const esquemaPasso = z.number().int().min(1).max(5);

export async function definirTema(valor: "aparelho" | "claro" | "escuro"): Promise<void> {
  const tema = esquemaTema.parse(valor);
  const armazem = await cookies();
  if (tema === "aparelho") {
    armazem.delete(COOKIE_TEMA);
  } else {
    armazem.set(COOKIE_TEMA, tema, opcoes());
  }
}

export async function definirPasso(passo: 1 | 2 | 3 | 4 | 5): Promise<void> {
  const valido = esquemaPasso.parse(passo);
  (await cookies()).set(COOKIE_ESCALA, String(valido), opcoes());
}
