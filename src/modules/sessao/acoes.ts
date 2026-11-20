"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { ErroDeBanco } from "@/db/erro-banco";
import { registrarErro } from "@/lib/registro";
import { exigirSessao } from "@/modules/identidade/sessao";
import { abrirSessao, encerrarSessao } from "./consultas";

// Server Actions da Sessão (TRIL-03). Cada uma exige sessão E o aceite do aviso antes de qualquer coisa
// (`exigirSessao()` sem opção: ação de Sessão nunca dispensa o consentimento); a escrita passa só por
// `comEstudante`, e o Estudo é sempre resolvido no servidor pelo slug. O cliente manda um slug e um texto
// e nada mais. Sem conexão a chamada nem chega aqui: a tela mostra o erro de conexão e não guarda fila.
//
// A Anotação da Sessão é texto privado: nunca vai a registro, a erro nem a URL. `registrarErro` recebe só
// o contexto e o erro do banco (já saneado), nunca o texto.

export type ResultadoCheckIn =
  | { ok: true; jaAberta: boolean }
  | { ok: false; erro: "nao-encontrado" | "falha" };

export type ResultadoCheckOut =
  | { ok: true; minutos: number; de: string; ate: string }
  | { ok: false; erro: "sem-sessao-aberta" | "anotacao-invalida" | "falha" };

const slugDoEstudo = z.string().min(1).max(200);

// A conta foi apagada (em outra aba) entre a guarda de sessão e a escrita: a chave estrangeira para
// `auth.user` recusa a linha (23503). Não é falha do banco nem erro para mostrar: a sessão acabou.
function sessaoEncerradaPorApagarConta(erro: unknown): boolean {
  return (
    erro instanceof ErroDeBanco &&
    erro.code === "23503" &&
    (erro.constraint ?? "").includes("estudante_id")
  );
}

// A faixa aparece em /trilhas e em todo /estudos/[slug]: as duas leituras se refazem na mesma resposta.
function atualizarTelas(): void {
  revalidatePath("/trilhas");
  revalidatePath("/estudos/[slug]", "layout");
}

export async function fazerCheckIn(entrada: { estudoSlug?: string }): Promise<ResultadoCheckIn> {
  const { usuario } = await exigirSessao();
  const slug =
    entrada?.estudoSlug === undefined ? undefined : slugDoEstudo.safeParse(entrada.estudoSlug);
  if (slug && !slug.success) return { ok: false, erro: "nao-encontrado" };
  try {
    const aberta = await abrirSessao(usuario.id, { estudoSlug: slug?.data });
    if (!aberta.ok) return { ok: false, erro: "nao-encontrado" };
    atualizarTelas();
    return { ok: true, jaAberta: aberta.jaAberta };
  } catch (erro) {
    if (sessaoEncerradaPorApagarConta(erro)) redirect("/entrar?motivo=sessao");
    registrarErro("sessao-check-in", erro);
    return { ok: false, erro: "falha" };
  }
}

export async function fazerCheckOut(dados: FormData): Promise<ResultadoCheckOut> {
  const { usuario } = await exigirSessao();
  const anotacao = dados.get("anotacao");
  const slugAtual = dados.get("estudoSlug");
  // O id da Sessão que a folha mostrava ao abrir: o servidor encerra essa, e só essa.
  const sessaoId = dados.get("sessaoId");
  // Um valor que não é texto (um arquivo, por exemplo) não é Anotação.
  if (anotacao !== null && typeof anotacao !== "string") {
    return { ok: false, erro: "anotacao-invalida" };
  }
  const slug = typeof slugAtual === "string" ? slugDoEstudo.safeParse(slugAtual) : null;
  try {
    const resultado = await encerrarSessao(usuario.id, {
      sessaoId: typeof sessaoId === "string" ? sessaoId : null,
      estudoSlugAtual: slug?.success ? slug.data : null,
      anotacao,
    });
    // Só o sucesso refaz as telas: se outra aba já encerrou, refazer a faixa agora fecharia a folha e
    // levaria embora o texto que a pessoa digitou. A folha mesma refaz a tela quando for fechada.
    if (resultado.ok) atualizarTelas();
    return resultado;
  } catch (erro) {
    if (sessaoEncerradaPorApagarConta(erro)) redirect("/entrar?motivo=sessao");
    registrarErro("sessao-check-out", erro);
    return { ok: false, erro: "falha" };
  }
}
