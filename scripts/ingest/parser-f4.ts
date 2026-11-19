// Interpretador do formato f4 da Bíblia Livre (marcadores de linha: \v, \added, \fn, \key, \ref, \psalm-title).
// Qualquer marcador desconhecido ou fora de lugar lança ErroF4 com o número da linha: nada é ignorado em silêncio.

import { readFileSync } from "node:fs";
import { chave } from "../../src/modules/referencias/chave";

export type Nota = { chave: string | null; texto: string };

export type Versiculo = {
  chave: number;
  texto: string;
  notas: Nota[];
  refs: string[];
  adicionados: string[];
  titulo: string | null;
  duvidoso: boolean;
};

export type LinhaTabela = { prefixo: string; arquivo: string; livro: number; nome: string };

/**
 * Defeito de marcação do arquivo de origem, corrigido por linha. `de` tem de casar exatamente com a linha
 * original (senão a correção falha), e `para` é a lista de linhas que a substituem (vazia remove a linha).
 * Só marcadores mudam; o texto bíblico nunca é reescrito.
 */
export type Correcao = { linha: number; de: string; para: string[] };

export type Relatorio = { correcoesAplicadas: number };

export class ErroF4 extends Error {
  readonly linha: number;
  constructor(mensagem: string, linha: number) {
    super(`${mensagem} (linha ${linha})`);
    this.name = "ErroF4";
    this.linha = linha;
  }
}

export const CAMINHO_TABELA = new URL("../../data/versificacao/biblia-livre.csv", import.meta.url);

export function lerTabela(csv: string): LinhaTabela[] {
  const linhas = csv.split("\n").filter((l) => l.trim() !== "");
  if (linhas[0] !== "prefixo,arquivo,livro,nome")
    throw new Error("cabeçalho do CSV de correspondência inesperado");
  return linhas.slice(1).map((l, i) => {
    const c = l.split(",");
    if (c.length !== 4) throw new Error(`CSV de correspondência: linha ${i + 2} não tem 4 colunas`);
    return {
      prefixo: c[0] as string,
      arquivo: c[1] as string,
      livro: Number(c[2]),
      nome: c[3] as string,
    };
  });
}

export function carregarTabela(): LinhaTabela[] {
  return lerTabela(readFileSync(CAMINHO_TABELA, "utf8"));
}

export function mapaDePrefixos(tabela: LinhaTabela[]): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const l of tabela) {
    if (mapa.has(l.prefixo)) throw new Error(`prefixo repetido na tabela: ${l.prefixo}`);
    mapa.set(l.prefixo, l.livro);
  }
  return mapa;
}

const CABECALHO = new Set(["name-long", "name-short", "abbreviation", "ubs-code"]);
const RE_MARCADOR = /^\\(\*?)([a-z][a-z-]*)(.*)$/;
const RE_ID = /^([A-Za-z0-9]+)\.(\d+)\.(\d+)$/;

type Acumulador = { buf: string; aposLinha: boolean };
const novo = (): Acumulador => ({ buf: "", aposLinha: false });
function linhaEm(a: Acumulador, s: string): void {
  if (a.aposLinha) a.buf += " ";
  a.buf += s;
  a.aposLinha = true;
}
function cola(a: Acumulador, s: string): void {
  a.buf += s;
  a.aposLinha = true;
}
const limpo = (a: Acumulador): string => a.buf.replace(/\s+/g, " ").trim();

type Modo = "fora" | "cabecalho" | "texto" | "added" | "fn" | "key" | "ref" | "psalm-title";

export function interpretarF4(
  texto: string,
  mapaPrefixos: ReadonlyMap<string, number>,
  correcoes: readonly Correcao[] = [],
  relatorio?: Relatorio,
): Versiculo[] {
  const originais = texto.replace(/^﻿/, "").split("\n");
  const porLinha = new Map(correcoes.map((c) => [c.linha, c]));
  if (porLinha.size !== correcoes.length) throw new ErroF4("duas correções para a mesma linha", 0);
  const linhas: string[] = [];
  const origemDe: number[] = [];
  let aplicadas = 0;
  originais.forEach((l, idx) => {
    const c = porLinha.get(idx + 1);
    if (!c) {
      linhas.push(l);
      origemDe.push(idx + 1);
      return;
    }
    if (l.replace(/\r$/, "") !== c.de) {
      throw new ErroF4(
        `a correção não casa com a linha: esperava "${c.de}", achei "${l.slice(0, 40)}"`,
        idx + 1,
      );
    }
    for (const nova of c.para) {
      linhas.push(nova);
      origemDe.push(idx + 1);
    }
    aplicadas++;
  });
  if (aplicadas !== correcoes.length) {
    const faltou = correcoes.find((c) => c.linha > originais.length);
    throw new ErroF4("correção aponta para linha que não existe", faltou?.linha ?? 0);
  }
  if (relatorio) relatorio.correcoesAplicadas = aplicadas;
  const saida: Versiculo[] = [];

  let modo: Modo = "fora";
  let cab = "";
  let corpo = novo();
  let atual: Omit<Versiculo, "texto" | "duvidoso"> | null = null;
  let adicionado = novo();
  let nota: { chave: Acumulador; texto: Acumulador } = { chave: novo(), texto: novo() };
  let temChave = false;
  let ref = novo();
  let tituloPendente: Acumulador | null = null;
  let tituloAcc = novo();
  let modoAntesTitulo: Modo = "fora";

  const fechaVersiculo = () => {
    if (!atual) return;
    const t = limpo(corpo);
    saida.push({ ...atual, texto: t, duvidoso: t.includes("«") || t.includes("»") });
    atual = null;
    corpo = novo();
  };

  for (let i = 0; i < linhas.length; i++) {
    const n = origemDe[i] as number;
    const bruta = (linhas[i] as string).replace(/\r$/, "");
    const m = RE_MARCADOR.exec(bruta);

    if (!m) {
      const t = bruta;
      switch (modo) {
        case "cabecalho":
          break;
        case "fora":
          if (t.trim() !== "") throw new ErroF4(`texto fora de versículo: "${t.slice(0, 40)}"`, n);
          break;
        case "texto":
          linhaEm(corpo, t);
          break;
        case "added":
          linhaEm(corpo, t);
          linhaEm(adicionado, t);
          break;
        case "fn":
          linhaEm(nota.texto, t);
          break;
        case "key":
          linhaEm(nota.chave, t);
          break;
        case "ref":
          linhaEm(ref, t);
          break;
        case "psalm-title":
          linhaEm(tituloAcc, t);
          break;
      }
      continue;
    }

    const fecha = m[1] === "*";
    const nome = m[2] as string;
    const resto = m[3] as string;

    if (!fecha && nome === "v") {
      if (!/^ \S+\s*$/.test(resto))
        throw new ErroF4(`marcador \\v sem identificador: "${bruta}"`, n);
      if (modo !== "texto" && modo !== "fora")
        throw new ErroF4(`\\v dentro de ${modo} ainda aberto`, n);
      const id = resto.trim();
      const p = RE_ID.exec(id);
      if (!p) throw new ErroF4(`identificador de versículo malformado: "${id}"`, n);
      const livro = mapaPrefixos.get(p[1] as string);
      if (livro === undefined) throw new ErroF4(`prefixo de livro desconhecido: "${p[1]}"`, n);
      fechaVersiculo();
      let c: number;
      try {
        c = chave(livro, Number(p[2]), Number(p[3]));
      } catch (e) {
        throw new ErroF4(`identificador fora da faixa: "${id}" (${(e as Error).message})`, n);
      }
      atual = {
        chave: c,
        notas: [],
        refs: [],
        adicionados: [],
        titulo: tituloPendente ? limpo(tituloPendente) : null,
      };
      tituloPendente = null;
      modo = "texto";
      continue;
    }

    if (!fecha) {
      if (resto.trim() !== "")
        throw new ErroF4(`texto na linha do marcador \\${nome}: "${resto.trim()}"`, n);
      if (CABECALHO.has(nome)) {
        if (modo !== "fora") throw new ErroF4(`\\${nome} dentro de ${modo}`, n);
        modo = "cabecalho";
        cab = nome;
      } else if (nome === "added" || nome === "fn" || nome === "ref") {
        if (modo !== "texto")
          throw new ErroF4(`\\${nome} fora do texto de um versículo (modo ${modo})`, n);
        if (nome === "added") adicionado = novo();
        if (nome === "fn") {
          nota = { chave: novo(), texto: novo() };
          temChave = false;
        }
        if (nome === "ref") ref = novo();
        modo = nome;
      } else if (nome === "key") {
        if (modo !== "fn") throw new ErroF4("\\key fora de uma nota", n);
        if (temChave) throw new ErroF4("\\key repetido na mesma nota", n);
        nota.chave = novo();
        modo = "key";
      } else if (nome === "psalm-title") {
        // O título pertence ao versículo seguinte; pode vir com o versículo anterior ainda aberto.
        if (modo !== "texto" && modo !== "fora")
          throw new ErroF4(`\\psalm-title dentro de ${modo}`, n);
        tituloAcc = novo();
        modoAntesTitulo = modo;
        modo = "psalm-title";
      } else {
        throw new ErroF4(`marcador desconhecido: \\${nome}`, n);
      }
      continue;
    }

    // marcador de fechamento
    const volta = (esperado: Modo, para: Modo) => {
      if (modo !== esperado) throw new ErroF4(`\\*${nome} sem \\${nome} aberto (modo ${modo})`, n);
      modo = para;
    };
    if (CABECALHO.has(nome)) {
      if (modo !== "cabecalho" || cab !== nome)
        throw new ErroF4(`\\*${nome} não fecha o cabeçalho aberto`, n);
      modo = "fora";
      cab = "";
    } else if (nome === "added") {
      volta("added", "texto");
      atual?.adicionados.push(limpo(adicionado));
      if (resto.trim() !== "") cola(corpo, resto.trimEnd());
      else corpo.aposLinha = false;
      continue;
    } else if (nome === "key") {
      volta("key", "fn");
      temChave = true;
    } else if (nome === "fn") {
      volta("fn", "texto");
      atual?.notas.push({ chave: temChave ? limpo(nota.chave) : null, texto: limpo(nota.texto) });
      corpo.aposLinha = false;
    } else if (nome === "ref") {
      volta("ref", "texto");
      atual?.refs.push(limpo(ref));
      corpo.aposLinha = false;
    } else if (nome === "psalm-title") {
      volta("psalm-title", modoAntesTitulo);
      tituloPendente = tituloAcc;
    } else {
      throw new ErroF4(`marcador desconhecido: \\*${nome}`, n);
    }
    if (resto.trim() !== "" && nome !== "fn" && nome !== "ref") {
      throw new ErroF4(`texto depois de \\*${nome}: "${resto.trim()}"`, n);
    }
    // Texto depois do fechamento é continuação do versículo (ex.: "\*fn  " ou "\*added”.").
    if (resto.trim() !== "" && (nome === "fn" || nome === "ref")) cola(corpo, resto.trimEnd());
  }

  if (modo !== "fora" && modo !== "texto")
    throw new ErroF4(`arquivo terminou com \\${modo} aberto`, linhas.length);
  fechaVersiculo();
  if (tituloPendente) throw new ErroF4("\\psalm-title sem versículo depois dele", linhas.length);
  return saida;
}
