// Linhas de seção do formulário de Fonte do painel e o casamento da resposta do servidor com elas (ACER-08).
//
// Duas regras, nascidas de três rodadas de revisão cruzada sobre a mesma superfície:
//
// 1. A resposta do servidor é casada com as linhas do cliente por `cid` (id do cliente), NUNCA pela posição: se a lista muda
//    com o pedido no ar, a posição de ontem já não é a mesma linha.
// 2. Uma seção que já existe é identificada por DUAS coisas que o servidor deu: o `id` (a chave dela) e o `versao` (um uuid que
//    o banco regera a cada escrita). A edição escreve só na linha com aquele `id` e só se o `versao` é o atual; o endereço
//    (`slug`) é só exibição.
//
// O `cid` de uma seção que já existe é DERIVADO do `id` dela: o servidor e o navegador chegam ao mesmo valor e os atributos
// `id`, `htmlFor` e `aria-describedby` não divergem na hidratação. Só a linha criada no navegador ganha `cid` novo.

export type SecaoEmEdicao = {
  /** Id do cliente, estável durante a vida do formulário. Nunca é gravado no banco. */
  cid: string;
  /** A chave da seção no banco, dada pelo servidor; ausente enquanto a seção é nova. */
  id?: string;
  /** Versão da seção que o formulário viu pela última vez (uuid regerado a cada escrita); ausente enquanto nova. */
  versao?: string;
  titulo: string;
  texto: string;
  resumo_pt: string;
  palavras_chave_pt: string;
};

/** O que o servidor devolve por seção enviada: o `cid` que recebeu, o id dado e a versão depois de salvar. */
export type SecaoSalva = { cid: string; id: string; versao: string };

/** Seção como a página a leu do banco. */
export type SecaoPersistida = {
  id: string;
  versao: string;
  titulo: string | null;
  texto: string;
  resumoPt: string | null;
  palavrasChavePt: string[];
};

let contador = 0;

/** Um `cid` novo, só para linha criada no navegador (nunca na renderização inicial: seria diferente no servidor). */
export function novoCid(): string {
  contador += 1;
  return `n${Date.now().toString(36)}-${contador}`;
}

/**
 * Hash de 53 bits (cyrb53) de uma string, em número inteiro. Puro JS e síncrono: roda igual no servidor e no navegador (o
 * `crypto.subtle` é assíncrono e não serve a uma renderização inicial). Não é criptográfico: o `cid` só casa linhas do
 * formulário e nunca é identidade (a identidade é `id` + `versao`).
 */
function cyrb53(texto: string, semente: number): number {
  let h1 = 0xdeadbeef ^ semente;
  let h2 = 0x41c6ce57 ^ semente;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * O `cid` de uma seção que já existe: derivado do id dela, igual no servidor e no navegador, e de TAMANHO FIXO (no máximo 24
 * caracteres), qualquer que seja o id: o id leva o endereço da Fonte e da seção (até ~200 caracteres) e o contrato do `cid`
 * é de no máximo 64. Dois hashes de 53 bits com sementes diferentes (106 bits) tornam colisão entre as seções de uma Fonte
 * (máx. 60) irrelevante; o `cid` só casa a resposta com a linha, nunca identifica a seção no servidor.
 */
export function cidDaSecaoPersistida(id: string): string {
  return `p-${cyrb53(id, 0).toString(36)}${cyrb53(id, 1).toString(36)}`;
}

/** As linhas iniciais do formulário, determinísticas: a mesma entrada dá os mesmos `cid` em qualquer lugar. */
export function secoesIniciais(persistidas: readonly SecaoPersistida[]): SecaoEmEdicao[] {
  return persistidas.map((s) => ({
    cid: cidDaSecaoPersistida(s.id),
    id: s.id,
    versao: s.versao,
    titulo: s.titulo ?? "",
    texto: s.texto,
    resumo_pt: s.resumoPt ?? "",
    palavras_chave_pt: s.palavrasChavePt.join(", "),
  }));
}

/** Aplica a resposta às linhas ATUAIS, casando por `cid`. Linhas removidas durante o pedido são ignoradas. */
export function aplicarSalvamento(
  atuais: readonly SecaoEmEdicao[],
  salvas: readonly SecaoSalva[],
): SecaoEmEdicao[] {
  const porCid = new Map(salvas.map((s) => [s.cid, s]));
  return atuais.map((linha) => {
    const salva = porCid.get(linha.cid);
    return salva ? { ...linha, id: salva.id, versao: salva.versao } : linha;
  });
}
