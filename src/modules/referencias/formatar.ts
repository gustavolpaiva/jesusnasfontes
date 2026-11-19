// Duas saídas do mesmo interpretador: a referência por extenso (tela) e a forma falada (Ouvir).

import { type Item, type Ponto, parsearItens } from "./parser";

function juntar(partes: string[]): string {
  if (partes.length <= 1) return partes.join("");
  return `${partes.slice(0, -1).join(", ")} e ${partes[partes.length - 1]}`;
}

function escrever(p: Ponto): string {
  return p.versiculo === undefined ? String(p.capitulo) : `${p.capitulo}:${p.versiculo}`;
}

function extenso(item: Item, anterior: Item | undefined): string {
  const pre = anterior?.livro.numero === item.livro.numero ? "" : `${item.livro.nome} `;
  const { inicio, fim } = item;
  const ini = escrever(inicio);
  if (!fim) return `${pre}${ini}`;
  if (fim.capitulo === inicio.capitulo && fim.versiculo !== undefined) {
    return `${pre}${ini}-${fim.versiculo}`;
  }
  if (fim.versiculo === undefined) return `${pre}${ini}-${fim.capitulo}`;
  return `${pre}${ini} a ${escrever(fim)}`;
}

export function formatarReferencia(texto: string): string {
  const itens = parsearItens(texto);
  return juntar(itens.map((it, i) => extenso(it, itens[i - 1])));
}

function plural(n: number, um: string, varios: string): string {
  return n === 1 ? um : varios;
}

function falado(item: Item): string {
  const { livro, inicio, fim } = item;
  const nome = livro.nome;
  if (livro.capitulos === 1 && inicio.versiculo !== undefined) {
    if (fim?.versiculo !== undefined)
      return `${nome}, versículos ${inicio.versiculo} a ${fim.versiculo}`;
    return `${nome}, versículo ${inicio.versiculo}`;
  }
  if (inicio.versiculo === undefined) {
    if (!fim) return `${nome}, capítulo ${inicio.capitulo}`;
    return `${nome}, capítulos ${inicio.capitulo} a ${fim.capitulo}`;
  }
  if (!fim) return `${nome}, capítulo ${inicio.capitulo}, versículo ${inicio.versiculo}`;
  if (fim.capitulo === inicio.capitulo && fim.versiculo !== undefined) {
    const n = fim.versiculo === inicio.versiculo ? 1 : 2;
    if (n === 1) return `${nome}, capítulo ${inicio.capitulo}, versículo ${inicio.versiculo}`;
    return `${nome}, capítulo ${inicio.capitulo}, ${plural(n, "versículo", "versículos")} ${inicio.versiculo} a ${fim.versiculo}`;
  }
  return `${nome}, capítulo ${inicio.capitulo}, versículo ${inicio.versiculo} a capítulo ${fim.capitulo}, versículo ${fim.versiculo}`;
}

export function referenciaParaFala(texto: string): string {
  return parsearItens(texto).map(falado).join(". ");
}
