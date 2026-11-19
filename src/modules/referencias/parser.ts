// Interpretador estrito de referências em português ("Mt 3:13 a 4:11", "Jo 13:1-17, 13:34-35 e Lc 22:14-20").
// Texto não interpretável lança ErroReferencia com a posição; nada é adivinhado.

import { chave } from "./chave";
import { LIVROS, type Livro } from "./livros";

export type Intervalo = { inicio: number; fim: number };

/** Ponto de um intervalo: capítulo e, quando escrito, versículo. */
export type Ponto = { capitulo: number; versiculo?: number };

/** Um item da referência já resolvido: livro, pontos escritos e o intervalo de chaves. */
export type Item = {
  livro: Livro;
  inicio: Ponto;
  fim?: Ponto;
  intervalo: Intervalo;
};

export type OpcoesReferencia = {
  /** Livro assumido quando o texto começa sem livro ("6:51-58"). Sem ele, a falta de livro é erro. */
  livroPadrao?: number;
};

export class ErroReferencia extends Error {
  readonly posicao: number;
  readonly texto: string;
  constructor(mensagem: string, texto: string, posicao: number) {
    super(`${mensagem} (posição ${posicao}) em "${texto}"`);
    this.name = "ErroReferencia";
    this.posicao = posicao;
    this.texto = texto;
  }
}

function normalizar(nome: string): string {
  return nome.normalize("NFC").toLowerCase().replace(/[\s.]/g, "");
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

// Chaves exatas (com acento) primeiro; as sem acento só entram onde não colidem:
// "Jo" é João e "Jó" é Jó, e a forma sem acento de Jó nunca toma o lugar de João.
const POR_NOME = new Map<string, Livro>();
(() => {
  for (const livro of LIVROS) {
    for (const nome of [livro.nome, ...livro.abreviacoes]) {
      const k = normalizar(nome);
      const atual = POR_NOME.get(k);
      if (atual && atual.numero !== livro.numero) {
        throw new Error(`nome de livro ambíguo: "${nome}" em ${atual.nome} e ${livro.nome}`);
      }
      POR_NOME.set(k, livro);
    }
  }
  for (const livro of LIVROS) {
    for (const nome of [livro.nome, ...livro.abreviacoes]) {
      const k = semAcento(normalizar(nome));
      if (!POR_NOME.has(k)) POR_NOME.set(k, livro);
    }
  }
})();

export function buscarLivro(nome: string): Livro | undefined {
  return POR_NOME.get(normalizar(nome));
}

const RE_LIVRO = /^((?:[1-3]\s*)?[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s.]*?)\s*(?=\d)/u;
const RE_NUM = /^\d{1,3}/;
const RE_TRAVESSAO = /^[-–—]/;
const RE_A = /^a(?=\s+\d)/;
const RE_E = /^e(?=\s)/;

type Estado = {
  livro: Livro | null;
  capitulo: number | null;
  comVersiculo: boolean;
};

export function parsearItens(texto: string, opcoes: OpcoesReferencia = {}): Item[] {
  let pos = 0;
  const falha = (msg: string, p = pos): never => {
    throw new ErroReferencia(msg, texto, p);
  };
  const espacos = () => {
    while (pos < texto.length && /\s/.test(texto[pos] as string)) pos++;
  };
  const resto = () => texto.slice(pos);

  const padrao = opcoes.livroPadrao === undefined ? null : (LIVROS[opcoes.livroPadrao - 1] ?? null);
  if (opcoes.livroPadrao !== undefined && !padrao) falha("livroPadrao inválido", 0);
  const estado: Estado = { livro: padrao, capitulo: null, comVersiculo: false };

  const numero = (): number => {
    const m = RE_NUM.exec(resto());
    if (!m) return falha("número esperado");
    pos += m[0].length;
    return Number(m[0]);
  };

  const ponto = (livro: Livro, contextoVersiculo: boolean, capAtual: number | null): Ponto => {
    const n1 = numero();
    if (texto[pos] === ":") {
      pos++;
      const n2 = numero();
      return { capitulo: n1, versiculo: n2 };
    }
    if (livro.capitulos === 1) return { capitulo: 1, versiculo: n1 };
    if (contextoVersiculo && capAtual !== null) return { capitulo: capAtual, versiculo: n1 };
    return { capitulo: n1 };
  };

  const ultimo = (livro: Livro, cap: number, p: number): number => {
    if (cap < 1 || cap > livro.capitulos) {
      return falha(
        `${livro.nome} tem ${livro.capitulos} capítulo(s); capítulo ${cap} não existe`,
        p,
      );
    }
    return livro.ultimoVersiculo[cap - 1] as number;
  };

  const chaveInicio = (livro: Livro, pt: Ponto, p: number): number => {
    const ult = ultimo(livro, pt.capitulo, p);
    const v = pt.versiculo ?? 1;
    if (v < 1 || v > ult)
      falha(`${livro.nome} ${pt.capitulo} tem ${ult} versículo(s); versículo ${v} não existe`, p);
    return chave(livro.numero, pt.capitulo, v);
  };
  const chaveFim = (livro: Livro, pt: Ponto, p: number): number => {
    const ult = ultimo(livro, pt.capitulo, p);
    const v = pt.versiculo ?? ult;
    if (v < 1 || v > ult)
      falha(`${livro.nome} ${pt.capitulo} tem ${ult} versículo(s); versículo ${v} não existe`, p);
    return chave(livro.numero, pt.capitulo, v);
  };

  const itens: Item[] = [];
  espacos();
  if (pos >= texto.length) falha("referência vazia", 0);

  for (;;) {
    espacos();
    const inicioItem = pos;
    const mLivro = RE_LIVRO.exec(resto());
    if (mLivro) {
      const achado = buscarLivro(mLivro[1] as string);
      if (!achado) falha(`livro desconhecido: "${(mLivro[1] as string).trim()}"`);
      estado.livro = achado ?? null;
      estado.capitulo = null;
      estado.comVersiculo = false;
      pos += mLivro[0].length;
    } else if (!estado.livro) {
      falha("livro ausente: a referência não diz de qual livro fala");
    }
    const livro = estado.livro as Livro;

    const ini = ponto(livro, estado.comVersiculo, estado.capitulo);
    const iniChave = chaveInicio(livro, ini, inicioItem);
    espacos();

    let fim: Ponto | undefined;
    let fimChave = iniChave;
    const sub = resto();
    let separou = false;
    if (RE_TRAVESSAO.test(sub)) {
      pos += 1;
      separou = true;
    } else if (RE_A.test(sub)) {
      pos += 1;
      separou = true;
    }
    if (separou) {
      espacos();
      const posFim = pos;
      // Depois do intervalo, número solo é versículo se o início trazia versículo.
      fim = ponto(livro, ini.versiculo !== undefined, ini.capitulo);
      fimChave = chaveFim(livro, fim, posFim);
    } else if (ini.versiculo === undefined) {
      fimChave = chaveFim(livro, ini, inicioItem);
    }
    if (fimChave < iniChave) falha("intervalo invertido: o fim vem antes do início", inicioItem);

    itens.push({
      livro,
      inicio: ini,
      ...(fim ? { fim } : {}),
      intervalo: { inicio: iniChave, fim: fimChave },
    });
    const ultimoPt = fim ?? ini;
    estado.capitulo = ultimoPt.capitulo;
    estado.comVersiculo = ultimoPt.versiculo !== undefined;

    espacos();
    if (pos >= texto.length) break;
    const c = texto[pos];
    if (c === "," || c === ";") {
      pos++;
    } else if (RE_E.test(resto())) {
      pos += 1;
    } else {
      falha(`separador esperado (",", ";" ou " e "), achei "${resto().slice(0, 8)}"`);
    }
    espacos();
    if (pos >= texto.length) falha("item esperado depois do separador");
  }
  return itens;
}

export function parsearReferencia(texto: string, opcoes: OpcoesReferencia = {}): Intervalo[] {
  return parsearItens(texto, opcoes).map((i) => i.intervalo);
}
