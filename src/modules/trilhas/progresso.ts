"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ErroDeBanco } from "@/db/erro-banco";
import { registrarErro } from "@/lib/registro";
import { exigirSessao } from "@/modules/identidade/sessao";
import { iniciarNovaVolta, registrarConclusao, removerConclusao } from "./consultas";

// Server Actions do progresso (TRIL-04, TRIL-06). Cada uma exige sessão antes de qualquer coisa; a
// escrita passa só por `comEstudante` (a RLS forçada decide de quem é a linha) e o id do Estudo é
// validado contra `conteudo.estudo`: o cliente manda um id e nada mais. Sem conexão a chamada nem chega
// aqui; a tela mostra o erro de conexão e não guarda fila.

export type ResultadoProgresso =
  | { ok: true; concluidos: number; total: number; trilha: string; volta: number }
  | { ok: false; erro: "nao-encontrado" | "falha" };

export type ResultadoNovaVolta =
  | { ok: true; volta: number }
  | { ok: false; erro: "incompleta" | "falha" | "sessao-trocada" };

const idDoEstudo = z.uuid();

// A conta foi apagada (em outra aba) entre a guarda de sessão e a escrita: a chave estrangeira para
// `auth.user` recusa a linha (23503). Não é falha do banco nem erro para mostrar: a sessão acabou.
function sessaoEncerradaPorApagarConta(erro: unknown): boolean {
  return (
    erro instanceof ErroDeBanco &&
    erro.code === "23503" &&
    (erro.constraint ?? "").includes("estudante_id")
  );
}

// A Trilha e a página do Estudo mostram o novo estado na mesma resposta da ação.
function atualizarTelas(slug: string): void {
  revalidatePath("/trilhas");
  revalidatePath(`/estudos/${slug}`);
}

export async function concluirEstudo(estudoId: string): Promise<ResultadoProgresso> {
  const { usuario } = await exigirSessao();
  const id = idDoEstudo.safeParse(estudoId);
  if (!id.success) return { ok: false, erro: "nao-encontrado" };
  try {
    const feito = await registrarConclusao(usuario.id, id.data);
    if (!feito) return { ok: false, erro: "nao-encontrado" };
    atualizarTelas(feito.slug);
    return { ok: true, ...feito };
  } catch (erro) {
    if (sessaoEncerradaPorApagarConta(erro)) redirect("/entrar?motivo=sessao");
    registrarErro("progresso-concluir", erro);
    return { ok: false, erro: "falha" };
  }
}

export async function desmarcarConclusao(estudoId: string): Promise<ResultadoProgresso> {
  const { usuario } = await exigirSessao();
  const id = idDoEstudo.safeParse(estudoId);
  if (!id.success) return { ok: false, erro: "nao-encontrado" };
  try {
    const feito = await removerConclusao(usuario.id, id.data);
    if (!feito) return { ok: false, erro: "nao-encontrado" };
    atualizarTelas(feito.slug);
    return { ok: true, ...feito };
  } catch (erro) {
    if (sessaoEncerradaPorApagarConta(erro)) redirect("/entrar?motivo=sessao");
    registrarErro("progresso-desmarcar", erro);
    return { ok: false, erro: "falha" };
  }
}

// A nova volta não se desfaz: a tela leva o id de quem a abriu, e se a sessão de agora é de outra conta (o navegador
// entrou com outra depois de a tela abrir) nada é iniciado.
export async function comecarNovaVolta(estudanteId: string): Promise<ResultadoNovaVolta> {
  const { usuario } = await exigirSessao();
  if (estudanteId !== usuario.id) return { ok: false, erro: "sessao-trocada" };
  try {
    const resultado = await iniciarNovaVolta(usuario.id);
    if (resultado.ok) revalidatePath("/trilhas");
    return resultado;
  } catch (erro) {
    if (sessaoEncerradaPorApagarConta(erro)) redirect("/entrar?motivo=sessao");
    registrarErro("progresso-nova-volta", erro);
    return { ok: false, erro: "falha" };
  }
}
