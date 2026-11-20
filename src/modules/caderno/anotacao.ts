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
  | { ok: false; erro: "invalida" | "falha" | "conta-apagada" | "sessao-trocada" };

const entradaDeSalvar = z.object({
  // Quem a tela acha que está escrevendo: o Estudante que abriu a página. Tem de ser o da sessão de agora.
  estudanteId: z.uuid(),
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

export type RespostaDeLer =
  | { ok: true; anotacao: AnotacaoDoEstudo | null }
  | { ok: false; erro: "sessao-trocada" };

// A sessão é um cookie, comum a todas as abas do navegador. Uma aba aberta como A continua viva depois de
// o navegador passar a ser de B (A saiu e B entrou em outra aba), e o que ela tem para enviar, ou para
// mostrar, não pode ir para a conta de B nem trazer o texto de B para a tela de A. Por isso cada chamada diz
// quem a tela acha que é, e a ação recusa, sem tocar no banco e sem devolver texto, se não for a sessão.
const mesmaPessoa = (esperado: string, sessao: string) => esperado === sessao;

/** O que o servidor tem agora para este Estudo (o navegador confere ao abrir e ao voltar para a aba). */
export async function lerAnotacao(estudoId: string, estudanteId: string): Promise<RespostaDeLer> {
  const { usuario } = await exigirSessao();
  if (!mesmaPessoa(estudanteId, usuario.id)) return { ok: false, erro: "sessao-trocada" };
  const id = z.uuid().safeParse(estudoId);
  if (!id.success) return { ok: true, anotacao: null };
  try {
    return { ok: true, anotacao: await lerAnotacaoDoEstudo(usuario.id, id.data) };
  } catch (erro) {
    registrarErro("anotacao-ler", erro);
    throw new Error("falha");
  }
}

export async function salvarAnotacao(entrada: unknown): Promise<RespostaDeSalvar> {
  const { usuario } = await exigirSessao();
  const lida = entradaDeSalvar.safeParse(entrada);
  if (!lida.success) return { ok: false, erro: "invalida" };
  if (!mesmaPessoa(lida.data.estudanteId, usuario.id)) return { ok: false, erro: "sessao-trocada" };
  try {
    const { estudanteId: _esperado, ...entrada } = lida.data;
    return await salvarAnotacaoDoEstudo(usuario.id, entrada);
  } catch (erro) {
    if (contaApagada(erro)) return { ok: false, erro: "conta-apagada" };
    registrarErro("anotacao-salvar", erro);
    return { ok: false, erro: "falha" };
  }
}
