// Para onde o Admin volta depois de confirmar o segundo fator (plano 02-18, T-02-47). O parâmetro `retorno` vem da barra
// de endereço ou de um campo do formulário: é entrada NÃO confiável, e um retorno aberto seria redirecionamento aberto.
// Vale uma lista FECHADA de prefixos de caminho interno, validada no servidor, mais uma forma estrita para o resto do
// caminho. Tudo o que não for exatamente isso é ignorado, e o Admin cai na administração como sempre.

/** Prefixos aceitos. Para uma tela nova de administração voltar do segundo fator, o prefixo entra AQUI, de propósito. */
export const PREFIXOS_DE_RETORNO: readonly string[] = ["/admin/acervo/fichas/"];

export const DESTINO_PADRAO = "/admin";

// O resto do caminho: um só segmento, letras minúsculas, dígitos, hífen, ponto, sublinhado e til (a forma de um slug).
// Nada de barra, barra invertida, `%`, `?`, `#`, `:`, espaço, controle ou não-ASCII.
const RESTO = /^[a-z0-9][a-z0-9._~-]{0,159}$/;

/** O caminho de retorno se for aceito; `null` caso contrário (nunca lança). */
export function retornoSeguro(valor: unknown): string | null {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > 200) return null;
  const prefixo = PREFIXOS_DE_RETORNO.find((p) => valor.startsWith(p));
  if (!prefixo) return null;
  const resto = valor.slice(prefixo.length);
  if (!RESTO.test(resto)) return null;
  if (resto === "." || resto === "..") return null;
  return valor;
}

/** Destino depois de confirmar: o retorno aceito, ou a administração. */
export function destinoDepoisDoSegundoFator(valor: unknown): string {
  return retornoSeguro(valor) ?? DESTINO_PADRAO;
}

/** Endereço da tela do segundo fator que volta ao caminho dado (só se o caminho for aceito). */
export function enderecoDoSegundoFator(rota: string, retorno: string): string {
  const ok = retornoSeguro(retorno);
  return ok ? `${rota}?retorno=${encodeURIComponent(ok)}` : rota;
}
