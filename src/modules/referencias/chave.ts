// Chave canônica de versículo: inteiro BBCCCVVV (livro 1 a 66 na ordem protestante,
// capítulo e versículo com 3 dígitos). João 3:16 = 43003016. Cabe em int4 (máximo 66999999).
// Porta de mão única: toda tabela que cita versículo guarda esta chave.

export const LIVRO_MIN = 1;
export const LIVRO_MAX = 66;
export const CAP_MAX = 999;
export const VER_MAX = 999;

export type Posicao = { livro: number; capitulo: number; versiculo: number };

function faixa(nome: string, valor: number, min: number, max: number): void {
  if (!Number.isInteger(valor) || valor < min || valor > max) {
    throw new RangeError(`${nome} fora da faixa ${min} a ${max}: ${String(valor)}`);
  }
}

export function chave(livro: number, capitulo: number, versiculo: number): number {
  faixa("livro", livro, LIVRO_MIN, LIVRO_MAX);
  faixa("capítulo", capitulo, 1, CAP_MAX);
  faixa("versículo", versiculo, 1, VER_MAX);
  return livro * 1_000_000 + capitulo * 1_000 + versiculo;
}

export function decompor(valor: number): Posicao {
  faixa("chave", valor, 1_001_001, LIVRO_MAX * 1_000_000 + CAP_MAX * 1_000 + VER_MAX);
  const livro = Math.floor(valor / 1_000_000);
  const capitulo = Math.floor((valor % 1_000_000) / 1_000);
  const versiculo = valor % 1_000;
  // Rejeita chaves que cabem no inteiro mas não são BBCCCVVV (capítulo ou versículo zero).
  faixa("livro", livro, LIVRO_MIN, LIVRO_MAX);
  faixa("capítulo", capitulo, 1, CAP_MAX);
  faixa("versículo", versiculo, 1, VER_MAX);
  return { livro, capitulo, versiculo };
}
