import { z } from "zod";

// A Anotação da Sessão (D-10): texto livre, opcional, no máximo 200 caracteres. Arquivo sem banco e sem
// servidor: o navegador usa a constante para a contagem, e o servidor valida de novo (nunca confia no
// `maxLength` do campo). O limite NÃO é uma restrição do banco, de propósito: o banco repete a linha
// inteira na mensagem de uma violação, e a linha carrega este texto.
//
// O texto é privado: nunca entra em log, em erro nem em URL. Nada aqui o devolve numa mensagem.

export const ANOTACAO_DA_SESSAO_MAX = 200;

const texto = z.string().max(ANOTACAO_DA_SESSAO_MAX);

export type AnotacaoValidada = { ok: true; valor: string | null } | { ok: false };

/**
 * `null`, vazio ou só espaços viram `null` (a Anotação é opcional). O nulo de texto (NUL) é tirado: o
 * Postgres não o guarda e a gravação falharia por um caractere que a pessoa nem vê. O limite vale para o
 * texto como ele chega (contado como o campo conta, em unidades de UTF-16), antes de aparar as pontas.
 */
export function validarAnotacaoDaSessao(entrada: unknown): AnotacaoValidada {
  if (entrada === null || entrada === undefined) return { ok: true, valor: null };
  const lido = texto.safeParse(entrada);
  if (!lido.success) return { ok: false };
  const limpo = lido.data.replaceAll("\u0000", "").trim();
  return { ok: true, valor: limpo === "" ? null : limpo };
}
