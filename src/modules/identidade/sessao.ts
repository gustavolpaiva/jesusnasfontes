import "server-only";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { obterAuth } from "@/lib/auth";
import { sessaoVerificada } from "./sessao-mfa";

export { sair } from "./entrada";

export type SessaoLida = {
  usuario: { id: string; email: string; papel: "estudante" | "admin" };
  sessao: { id: string; criadaEm: Date };
  // Só o Admin precisa do segundo fator (linha da sessão em admin.sessao_mfa); para os demais o valor
  // é sempre true.
  segundoFatorVerificado: boolean;
};

export const ROTA_SEGUNDO_FATOR = "/admin/segundo-fator";

// Cabeçalhos da requisição com o cookie ATUAL: uma Server Action que troca a sessão (a ativação do
// segundo fator) grava o cookie novo no armazém de cookies, mas o recarregamento que o Next faz na
// mesma requisição ainda enxerga o cabeçalho de entrada, com o cookie antigo. Ler o armazém evita
// ver a sessão que acabou de ser apagada.
async function cabecalhosAtuais(): Promise<Headers> {
  const novos = new Headers(await headers());
  const armazem = await cookies();
  const todos = armazem.getAll();
  if (todos.length > 0) {
    novos.set("cookie", todos.map((c) => `${c.name}=${c.value}`).join("; "));
  }
  return novos;
}

// Uma leitura por requisição, mesmo se layout e página perguntarem.
export const lerSessao = cache(async (): Promise<SessaoLida | null> => {
  const resultado = await obterAuth().api.getSession({ headers: await cabecalhosAtuais() });
  if (!resultado) return null;
  const papel = (resultado.user as { role?: string }).role === "admin" ? "admin" : "estudante";
  const sessaoId = resultado.session.id;
  return {
    usuario: { id: resultado.user.id, email: resultado.user.email, papel },
    sessao: { id: sessaoId, criadaEm: resultado.session.createdAt },
    segundoFatorVerificado: papel === "admin" ? await sessaoVerificada(sessaoId) : true,
  };
});

// A guarda única de páginas e Server Actions. Admin sem segundo fator verificado NESTA sessão não
// passa por aqui; só as telas do grupo (segundo-fator) e `sair` ficam fora dela, e usam
// `exigirPrimeiroFatorDeAdmin`. A assinatura não muda (o 01-14 estende com o consentimento).
export async function exigirSessao(_opcoes?: Record<string, never>): Promise<SessaoLida> {
  const sessao = await lerSessao();
  if (!sessao) redirect("/entrar?motivo=sessao");
  if (!sessao.segundoFatorVerificado) redirect(ROTA_SEGUNDO_FATOR);
  return sessao;
}

// Área de administração: quem não é Admin recebe a mesma 404 de qualquer endereço que não existe,
// ANTES de qualquer outra resposta (a existência da área não é revelada).
export async function exigirAdmin(): Promise<SessaoLida> {
  const sessao = await lerSessao();
  if (!sessao) redirect("/entrar?motivo=sessao");
  if (sessao.usuario.papel !== "admin") notFound();
  if (!sessao.segundoFatorVerificado) redirect(ROTA_SEGUNDO_FATOR);
  return sessao;
}

// Só para o cadastro e a verificação do segundo fator: Admin com a sessão de primeiro fator.
export async function exigirPrimeiroFatorDeAdmin(): Promise<SessaoLida> {
  const sessao = await lerSessao();
  if (!sessao) redirect("/entrar?motivo=sessao");
  if (sessao.usuario.papel !== "admin") notFound();
  return sessao;
}
