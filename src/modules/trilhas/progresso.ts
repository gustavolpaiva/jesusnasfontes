"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
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
  | { ok: false; erro: "incompleta" | "falha" };

const idDoEstudo = z.uuid();

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
    registrarErro("progresso-desmarcar", erro);
    return { ok: false, erro: "falha" };
  }
}

export async function comecarNovaVolta(): Promise<ResultadoNovaVolta> {
  const { usuario } = await exigirSessao();
  try {
    const resultado = await iniciarNovaVolta(usuario.id);
    if (resultado.ok) revalidatePath("/trilhas");
    return resultado;
  } catch (erro) {
    registrarErro("progresso-nova-volta", erro);
    return { ok: false, erro: "falha" };
  }
}
