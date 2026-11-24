"use server";

import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { obterDb } from "@/db/cliente";
import { sessao } from "@/db/schema/entrada";
import { obterAuth } from "@/lib/auth";
import { registrarErro } from "@/lib/registro";
import { conferirCodigo } from "./conferencia";
import { destinoDepoisDoSegundoFator } from "./retorno-segundo-fator";
import { exigirPrimeiroFatorDeAdmin } from "./sessao";
import {
  estadoDoCadastro,
  geracaoDoSegundoFator,
  reservarTentativaDaConta,
  reservarTentativaDaSessao,
  TENTATIVAS_POR_SESSAO,
} from "./sessao-mfa";

// Ações do segundo fator do Admin. Só este arquivo exporta Server Actions (tudo o que ele exporta é
// chamável pelo navegador); o estado e os limites moram em `sessao-mfa.ts`.
//
// Ordem de toda conferência, e por quê:
//   1. guarda: Admin com a sessão de primeiro fator (quem não é Admin recebe a 404);
//   2. reserva da tentativa da sessão e da conta, ANTES de comparar, em instrução atômica;
//   3. a biblioteca compara (`conferencia.ts`; no cadastro pendente os códigos de recuperação são lidos
//      ANTES de qualquer escrita); falha de qualquer tipo gasta a tentativa já reservada;
//   4. código de aplicativo: só vale a primeira vez (a biblioteca não lembra do que já viu);
//   5. só então a sessão (a que a operação deixou valendo) é marcada como verificada, por uma
//      instrução condicional à geração do segundo fator lida no começo (uma recuperação no meio
//      derrota a conferência, que não concede nada).

export type ResultadoSegundoFator = {
  resultado?: "incorreto" | "falha";
  restantes?: number;
  // Códigos de recuperação, devolvidos uma vez, na ativação.
  codigos?: string[];
};

const LIMITE_ENCERRA_SESSAO = "/entrar?motivo=segundo-fator";

// Encerra exatamente a sessão que fez as tentativas (a da guarda) e volta à entrada.
async function encerrarEVoltar(sessaoId: string): Promise<never> {
  try {
    await obterDb().delete(sessao).where(eq(sessao.id, sessaoId));
  } catch (erro) {
    registrarErro("segundo-fator-encerrar", erro);
  }
  redirect(LIMITE_ENCERRA_SESSAO);
}

// A sessão que vale depois da conferência. A biblioteca troca a sessão na ativação (cria outra e
// apaga a antiga) e grava o cookie novo no armazém de cookies da ação; o token dele identifica
// exatamente a sessão que a operação deixou valendo (nunca "a mais recente da conta").
async function sessaoQueValeDepois(idAntes: string): Promise<string> {
  const contexto = await obterAuth().$context;
  const bruto = (await cookies()).get(contexto.authCookies.sessionToken.name)?.value;
  const token = bruto ? decodeURIComponent(bruto).split(".")[0] : undefined;
  if (!token) return idAntes;
  const linhas = await obterDb()
    .select({ id: sessao.id })
    .from(sessao)
    .where(eq(sessao.token, token))
    .limit(1);
  return linhas[0]?.id ?? idAntes;
}

async function conferir(
  alvo: "aplicativo" | "recuperacao",
  formData: FormData,
): Promise<ResultadoSegundoFator> {
  const atual = await exigirPrimeiroFatorDeAdmin();
  // Para onde voltar: o campo `retorno` só vale se for um caminho interno da lista fechada (T-02-47); senão, a
  // administração. É entrada não confiável, validada aqui no servidor e nunca repassada como veio.
  const destino = destinoDepoisDoSegundoFator(formData.get("retorno"));
  if (atual.segundoFatorVerificado) redirect(destino);
  const bruto = String(formData.get("codigo") ?? "");
  const codigo = alvo === "aplicativo" ? bruto.replace(/\s/g, "") : bruto.trim();
  const formatoOk =
    alvo === "aplicativo" ? /^\d{6}$/.test(codigo) : /^[A-Za-z0-9-]{1,32}$/.test(codigo);
  const reserva = await reservarTentativaDaSessao(atual.sessao.id);
  if (!reserva.concedida) return encerrarEVoltar(atual.sessao.id);
  if (!(await reservarTentativaDaConta(atual.usuario.id))) return encerrarEVoltar(atual.sessao.id);

  const erradoOuFim = async (): Promise<ResultadoSegundoFator> => {
    if (reserva.usadas >= TENTATIVAS_POR_SESSAO) return encerrarEVoltar(atual.sessao.id);
    return { resultado: "incorreto", restantes: TENTATIVAS_POR_SESSAO - reserva.usadas };
  };

  try {
    // A geração em que esta conferência COMEÇA: se uma recuperação passar até o fim, a concessão
    // abaixo perde a comparação e não dá acesso a ninguém.
    const geracao = await geracaoDoSegundoFator(atual.usuario.id);
    const estado = await estadoDoCadastro(atual.usuario.id);
    // Recuperação só para segundo fator já ativo; aplicativo precisa de uma linha (ativa ou pendente).
    if (!formatoOk || estado === "sem-linha" || (alvo === "recuperacao" && estado !== "ativo")) {
      return await erradoOuFim();
    }
    const r = await conferirCodigo({
      api: obterAuth().api,
      alvo,
      codigo,
      usuarioId: atual.usuario.id,
      sessaoAtualId: atual.sessao.id,
      geracao,
      estado,
      cabecalhos: await headers(),
      sessaoQueVale: sessaoQueValeDepois,
    });
    if (r.tipo === "recusado") return await erradoOuFim();
    // Uma recuperação do segundo fator terminou no meio da conferência: nada vale. Encerra a sessão
    // que a biblioteca acabou de criar e volta à entrada.
    if (r.tipo === "perdida") return encerrarEVoltar(r.sessaoId);
    if (r.codigos) return { codigos: r.codigos };
  } catch (erro) {
    // Redirecionamentos e "não encontrado" do Next passam adiante; o resto é falha nossa.
    if (erro instanceof Error && "digest" in erro) throw erro;
    registrarErro("segundo-fator-conferir", erro);
    return { resultado: "falha" };
  }
  redirect(destino);
}

// Ativação (primeiro acesso): confere o código do aplicativo recém-cadastrado e devolve os códigos
// de recuperação uma única vez.
export async function ativarSegundoFator(
  _anterior: ResultadoSegundoFator,
  formData: FormData,
): Promise<ResultadoSegundoFator> {
  return conferir("aplicativo", formData);
}

// Entradas seguintes: código do aplicativo.
export async function verificarSegundoFator(
  _anterior: ResultadoSegundoFator,
  formData: FormData,
): Promise<ResultadoSegundoFator> {
  return conferir("aplicativo", formData);
}

// Entradas seguintes: um código de recuperação (cada um vale uma vez).
export async function usarCodigoDeRecuperacao(
  _anterior: ResultadoSegundoFator,
  formData: FormData,
): Promise<ResultadoSegundoFator> {
  return conferir("recuperacao", formData);
}
