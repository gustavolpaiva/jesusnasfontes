// Parser tolerante de HTML para o derivado do Acervo (plano 02-27): a página do Evangelho de Tomé na tradução
// de Mark M. Mattison (gospels.net). Entrada: página de TERCEIROS, tratada como dado não confiável. `htmlparser2`
// em modo HTML (não XML), que só decodifica as entidades que conhece e nunca resolve entidade externa; mesmo
// assim, DOCTYPE com subconjunto interno e ENTITY são recusados, o tamanho de entrada tem teto e nenhuma
// expressão regular é aplicada à página inteira (só ao texto já extraído de cada parágrafo, ou a uma etiqueta).
//
// Estrutura lida na página real (Squarespace; a página inteira está numa só linha física):
//   dito        um parágrafo centralizado cujo texto inteiro está em <strong> ("Saying 47: …"), seguido de um
//               ou mais parágrafos de corpo, até o parágrafo que só tem &nbsp; (o espaçador). Cada dito é UM
//               parágrafo do derivado; os parágrafos de corpo do mesmo dito são unidos por espaço. O título que o
//               tradutor deu ao dito ("True Meaning") não entra no texto.
//   região      começa no cabeçalho do dito 1 e termina no primeiro parágrafo comum onde se esperava o dito
//               seguinte (na página real: o título final "The Gospel / According to Thomas"). Tudo o mais —
//               navegação, dedicação, legenda de símbolos, Prólogo, "Notes on Translation" — não é dito e volta
//               à parte, em `notas`, para o derivador conferir que nada disso entrou num parágrafo.
//   numeração   conferida na ordem, sem lacuna: 1, 2, 3… Salto, repetição ou regresso reprova (nunca renumera).
// O que é texto de `script`, `style`, `noscript`, `template` ou comentário nunca é lido.

import { Parser } from "htmlparser2";
import { TETO_BRUTO_BYTES } from "./acervo-origens";
import type { SecaoTei } from "./acervo-parse-tei";

export class ErroHtml extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroHtml";
  }
}

export type ParagrafoHtml = {
  /** Texto do parágrafo, com espaços fechados. */
  texto: string;
  /** Todo o texto visível do parágrafo está dentro de <strong> (é um título, não corpo). */
  soNegrito: boolean;
};

/** O que o registro diz sobre a página (formato `html`). */
export type ConfigHtml = {
  /** Palavra que abre o cabeçalho de cada unidade ("Saying 1: …"). */
  rotuloUnidade: string;
};

export type OpcoesHtml = ConfigHtml & {
  /** Teto do tamanho de entrada em bytes (padrão: o do registro). */
  maxBytes?: number;
};

export type ResultadoHtml = {
  secoes: SecaoTei[];
  /** Texto de cada parágrafo que NÃO é dito, para o derivador conferir que nenhum entrou num parágrafo. */
  notas: string[];
};

const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const SEM_CONTEUDO = new Set(["script", "style", "noscript", "template"]);

/** conferência de entrada: teto e o que o modo HTML não deve deixar passar. */
function conferirEntrada(html: string, teto: number): void {
  if (Buffer.byteLength(html, "utf8") > teto)
    throw new ErroHtml(`página acima do teto de entrada (${teto} bytes)`);
  // Procura-se linha a linha: nunca a página inteira numa expressão regular só.
  for (const linha of html.split("\n")) {
    if (/<!DOCTYPE[^>]*\[/.test(linha) || /<!ENTITY/.test(linha))
      throw new ErroHtml(
        "DOCTYPE com subconjunto interno e ENTITY não são aceitos na página de origem",
      );
  }
}

/**
 * Lê os parágrafos (`p`) da página na ordem, com o texto visível de cada um, e também o texto visível inteiro.
 * É o que o verificador de dedicação usa: a frase vale pelo que o leitor vê, não pelo que está no código.
 */
export function lerParagrafosHtml(
  html: string,
  maxBytes?: number,
): { paragrafos: ParagrafoHtml[]; texto: string } {
  const teto = maxBytes ?? TETO_BRUTO_BYTES;
  conferirEntrada(html, teto);

  const paragrafos: ParagrafoHtml[] = [];
  let visivel = "";
  let semConteudo = 0;
  let negrito = 0;
  let profundidade = 0; // de `p`: um parágrafo só fecha quando o de fora fecha
  let partes: string[] = [];
  let textoForaDoNegrito = false;

  const acrescentar = (s: string) => {
    visivel += s;
    if (profundidade > 0) {
      partes.push(s);
      if (negrito === 0 && /\S/.test(s)) textoForaDoNegrito = true;
    }
  };
  const fechar = () => {
    paragrafos.push({ texto: compactar(partes.join("")), soNegrito: !textoForaDoNegrito });
    partes = [];
    textoForaDoNegrito = false;
  };

  const parser = new Parser(
    {
      onopentag(nome) {
        if (SEM_CONTEUDO.has(nome)) semConteudo++;
        else if (nome === "p") {
          if (profundidade === 0) {
            partes = [];
            textoForaDoNegrito = false;
          }
          profundidade++;
        } else if (nome === "strong") negrito++;
        else if (nome === "br") acrescentar(" ");
      },
      ontext(dados) {
        if (semConteudo === 0) acrescentar(dados);
      },
      onclosetag(nome) {
        if (SEM_CONTEUDO.has(nome)) semConteudo = Math.max(0, semConteudo - 1);
        else if (nome === "strong") negrito = Math.max(0, negrito - 1);
        else if (nome === "p" && profundidade > 0) {
          profundidade--;
          if (profundidade === 0) fechar();
        }
      },
    },
    { xmlMode: false, decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  if (profundidade > 0) fechar(); // página cortada no meio de um parágrafo

  return { paragrafos, texto: compactar(visivel) };
}

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Extrai os ditos. Lança `ErroHtml` quando a numeração salta, repete ou regreda, ou quando a página não tem
 * dito nenhum com o rótulo do registro.
 */
export function parsearHtml(html: string, opcoes: OpcoesHtml): ResultadoHtml {
  if (opcoes.rotuloUnidade.trim() === "")
    throw new ErroHtml(
      "formato html exige `rotulo_unidade` no registro (a palavra que abre cada dito)",
    );
  const { paragrafos } = lerParagrafosHtml(html, opcoes.maxBytes);
  const cabecalho = new RegExp(`^${escapar(compactar(opcoes.rotuloUnidade))} (\\d+):`, "i");

  /** Número do dito quando o parágrafo é um cabeçalho (texto inteiro em negrito, no molde "Saying 1: …"). */
  const numeroDoCabecalho = (p: ParagrafoHtml): number | null => {
    if (!p.soNegrito || p.texto === "") return null;
    const m = cabecalho.exec(p.texto);
    return m ? Number(m[1]) : null;
  };

  const blocos: { numero: number; textos: string[] }[] = [];
  const notas: string[] = [];
  let estado: "procurando" | "corpo" | "entre" | "fim" = "procurando";
  for (const p of paragrafos) {
    if (p.texto === "") {
      if (estado === "corpo") estado = "entre";
      continue;
    }
    if (estado === "procurando") {
      // O que vem antes do dito 1 (navegação, dedicação, legenda, Prólogo) não é dito.
      if (numeroDoCabecalho(p) === 1) {
        blocos.push({ numero: 1, textos: [] });
        estado = "corpo";
      } else notas.push(p.texto);
      continue;
    }
    if (estado === "fim") {
      notas.push(p.texto);
      continue;
    }
    // estados "corpo" e "entre": título em negrito pode ser o dito seguinte…
    const esperado = (blocos.at(-1)?.numero ?? 0) + 1;
    const n = p.soNegrito ? numeroDoCabecalho(p) : null;
    if (n !== null) {
      if (n !== esperado)
        throw new ErroHtml(
          `dito ${n} fora de sequência: depois do dito ${esperado - 1} esperava-se o ${esperado} ("${p.texto.slice(0, 60)}")`,
        );
      blocos.push({ numero: n, textos: [] });
      estado = "corpo";
      continue;
    }
    if (estado === "corpo") {
      blocos.at(-1)?.textos.push(p.texto);
      continue;
    }
    // …e qualquer outro parágrafo, onde se esperava o dito seguinte, encerra a região dos ditos.
    estado = "fim";
    notas.push(p.texto);
  }
  if (blocos.length === 0)
    throw new ErroHtml(
      `nenhum dito encontrado: esperado um título em negrito "${opcoes.rotuloUnidade.trim()} 1: …" seguido de texto`,
    );

  return {
    secoes: [
      {
        slug: "texto",
        titulo: "Text",
        ordem: 1,
        paragrafos: blocos.map((b) => ({
          // Um dito, um parágrafo: os parágrafos de corpo do mesmo dito são unidos por espaço.
          ref: String(b.numero),
          ref_inicio: null,
          ref_fim: null,
          texto: b.textos.join(" "),
        })),
      },
    ],
    notas,
  };
}
