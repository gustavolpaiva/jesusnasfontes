import "server-only";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { obterAuth } from "@/lib/auth";

export { sair } from "./entrada";

export type SessaoLida = {
  usuario: { id: string; email: string; papel: "estudante" | "admin" };
  sessao: { id: string; criadaEm: Date };
};

// Uma leitura por requisição, mesmo se layout e página perguntarem.
export const lerSessao = cache(async (): Promise<SessaoLida | null> => {
  const resultado = await obterAuth().api.getSession({ headers: await headers() });
  if (!resultado) return null;
  const papel = (resultado.user as { role?: string }).role === "admin" ? "admin" : "estudante";
  return {
    usuario: { id: resultado.user.id, email: resultado.user.email, papel },
    sessao: { id: resultado.session.id, criadaEm: resultado.session.createdAt },
  };
});

// Os planos 01-10 (segundo fator) e 01-14 (consentimento) estendem esta guarda sem mudar a assinatura.
export async function exigirSessao(_opcoes?: Record<string, never>): Promise<SessaoLida> {
  const sessao = await lerSessao();
  if (!sessao) redirect("/entrar?motivo=sessao");
  return sessao;
}

export async function exigirAdmin(): Promise<SessaoLida> {
  const sessao = await exigirSessao();
  if (sessao.usuario.papel !== "admin") notFound();
  return sessao;
}
