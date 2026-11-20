"use server";

import { z } from "zod";
import { ErroDeBanco } from "@/db/erro-banco";
import { registrarErro } from "@/lib/registro";
import { exigirSessao } from "@/modules/identidade/sessao";
import {
  type AnotacaoDoEstudo,
  lerAnotacaoDoEstudo,
  type ResultadoDeSalvar,
  salvarAnotacaoDoEstudo,
} from "./anotacao-nucleo";

// Server Actions da Anotação (ANOT-01, ANOT-02). Cada uma exige sessão E o aceite do aviso antes de
// qualquer coisa (`exigirSessao()` sem opção: ação da Anotação nunca dispensa o consentimento, e a lista
// fechada de quem dispensa não cresce). A escrita passa só por `comEstudante`. Sem conexão a chamada nem
// chega aqui: a tela guarda o rascunho no aparelho.
//
// O texto da Anotação é privado: nunca vai a registro, a erro nem a URL. `registrarErro` recebe só o
// contexto e o erro do banco (já saneado), nunca o texto. Num arquivo `'use server'` toda função
// exportada é uma ação; o núcleo, que não deve ser, mora em `anotacao-nucleo.ts`.

export type RespostaDeSalvar =
  | ResultadoDeSalvar
  | { ok: false; erro: "invalida" | "falha" | "conta-apagada" };

const entradaDeSalvar = z.object({
  estudoId: z.uuid(),
  // Sem `.max`: o limite é conferido no núcleo, que o devolve como erro próprio e nunca grava.
  corpo: z.string(),
  versaoBase: z.number().int().min(0).max(2_000_000_000),
  baseId: z.uuid().nullable(),
});

// A conta foi apagada (em outra aba) entre a guarda de sessão e a escrita: a chave estrangeira para
// `auth.user` recusa a linha (23503). Não é falha do banco: a sessão acabou, e o rascunho deste aparelho
// precisa ir embora com ela.
function contaApagada(erro: unknown): boolean {
  return (
    erro instanceof ErroDeBanco &&
    erro.code === "23503" &&
    (erro.constraint ?? "").includes("estudante_id")
  );
}

/** O que o servidor tem agora para este Estudo (o navegador confere ao abrir e ao voltar para a aba). */
export async function lerAnotacao(estudoId: string): Promise<AnotacaoDoEstudo | null> {
  const { usuario } = await exigirSessao();
  const id = z.uuid().safeParse(estudoId);
  if (!id.success) return null;
  try {
    return await lerAnotacaoDoEstudo(usuario.id, id.data);
  } catch (erro) {
    registrarErro("anotacao-ler", erro);
    throw new Error("falha");
  }
}

export async function salvarAnotacao(entrada: unknown): Promise<RespostaDeSalvar> {
  const { usuario } = await exigirSessao();
  const lida = entradaDeSalvar.safeParse(entrada);
  if (!lida.success) return { ok: false, erro: "invalida" };
  try {
    return await salvarAnotacaoDoEstudo(usuario.id, lida.data);
  } catch (erro) {
    if (contaApagada(erro)) return { ok: false, erro: "conta-apagada" };
    registrarErro("anotacao-salvar", erro);
    return { ok: false, erro: "falha" };
  }
}
