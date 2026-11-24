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
//
// FALHA EM VOZ ALTA: todo elemento da página está em UMA destas listas, e o que não está em nenhuma reprova a
// derivação com o nome do elemento e a posição (a página é uma linha só: vale o deslocamento em caracteres).
// Texto fora de parágrafo e fora de um descarte explícito também reprova; e um descarte com texto NO MEIO da
// região dos ditos (entre o dito 1 e o último parágrafo) reprova, porque ali seria texto da obra perdido.
//   ELEMENTOS_BLOCO       onde o texto vive (vira dito): p
//   ELEMENTOS_TEXTO       dentro do `p`, entram no texto: strong, em, a, br
//   ELEMENTOS_ESTRUTURA   contêineres, sem texto próprio: html, body, div, section, ul, li
//   ELEMENTOS_DESCARTADOS navegação e título do site, fora do texto por regra explícita: head, title, meta, base,
//                         link, img, nav, header, h1, h3 e script, style, noscript, template

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

export const ELEMENTOS_BLOCO: readonly string[] = ["p"];
export const ELEMENTOS_TEXTO: readonly string[] = ["strong", "em", "a", "br"];
export const ELEMENTOS_ESTRUTURA: readonly string[] = [
  "html",
  "body",
  "div",
  "section",
  "ul",
  "li",
];
export const ELEMENTOS_DESCARTADOS: readonly string[] = [
  "head",
  "title",
  "meta",
  "base",
  "link",
  "img",
  "nav",
  "header",
  "h1",
  "h3",
  "script",
  "style",
  "noscript",
  "template",
];
const DESCARTADOS = new Set(ELEMENTOS_DESCARTADOS);
/** O que é texto de `script`, `style`, `noscript` e `template` nunca é lido, nem para a frase de dedicação. */
const SEM_CONTEUDO = new Set(["script", "style", "noscript", "template"]);
const TEXTO = new Set(ELEMENTOS_TEXTO);
const ESTRUTURA = new Set(ELEMENTOS_ESTRUTURA);

/**
 * Conferência de entrada: teto e o que o modo HTML não deve deixar passar. LINEAR: a página pode ser uma linha só
 * muito longa (a do Mattison tem 56 mil caracteres), então nenhuma busca pode, a cada marca, correr até o fim da
 * linha — seria trabalho quadrático em dado de terceiros.
 */
function conferirEntrada(html: string, teto: number): void {
  if (Buffer.byteLength(html, "utf8") > teto)
    throw new ErroHtml(`página acima do teto de entrada (${teto} bytes)`);
  const min = html.toLowerCase();
  // ENTITY nunca é aceito: procura-se uma vez, fora do laço (a cada volta, procurar até o fim seria quadrático).
  if (min.includes("<!entity")) throw new ErroHtml("ENTITY não é aceito na página de origem");
  let i = 0;
  for (;;) {
    const declaracao = min.indexOf("<!doctype", i);
    if (declaracao < 0) return;
    // Subconjunto interno é um "[" entre a declaração e o que vier logo depois: o ">" que a fecha ou outra marca.
    // O laço de dentro para no primeiro ">" ou "<", e o de fora recomeça dele: cada posição é visitada uma vez.
    let j = declaracao + "<!doctype".length;
    for (; j < min.length; j++) {
      const c = min[j] as string;
      if (c === "[")
        throw new ErroHtml("DOCTYPE com subconjunto interno não é aceito na página de origem");
      if (c === ">" || c === "<") break;
    }
    if (j >= min.length) return;
    i = j;
  }
}

/**
 * Lê os parágrafos (`p`) da página na ordem, com o texto visível de cada um, e também o texto visível inteiro.
 * É o que o verificador de dedicação usa: a frase vale pelo que o leitor vê, não pelo que está no código.
 */
export type DescarteHtml = {
  elemento: string;
  /** Quantos parágrafos já tinham fechado quando o texto descartado apareceu. */
  paragrafosAntes: number;
  amostra: string;
  posicao: number;
};
export type LeituraHtml = {
  paragrafos: ParagrafoHtml[];
  texto: string;
  /** Elemento sem regra, ou texto fora de parágrafo e de descarte explícito: cada um reprova a derivação. */
  violacoes: string[];
  /** Texto descartado por regra explícita (navegação, título), com o ponto da página onde caiu. */
  descartes: DescarteHtml[];
};

export function lerParagrafosHtml(html: string, maxBytes?: number): LeituraHtml {
  const teto = maxBytes ?? TETO_BRUTO_BYTES;
  conferirEntrada(html, teto);

  const paragrafos: ParagrafoHtml[] = [];
  let visivel = "";
  let descartando = 0;
  let semConteudo = 0;
  const pilha: { descartado: boolean; semConteudo: boolean }[] = [];
  const nomes: string[] = [];
  const violacoes: string[] = [];
  const descartes: DescarteHtml[] = [];
  let negrito = 0;
  let profundidade = 0; // de `p`: um parágrafo só fecha quando o de fora fecha
  let partes: string[] = [];
  let textoForaDoNegrito = false;

  const acrescentar = (s: string) => {
    if (semConteudo === 0) visivel += s;
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

  const parser: Parser = new Parser(
    {
      onopentag(nome) {
        const descartado = DESCARTADOS.has(nome);
        const vazio = SEM_CONTEUDO.has(nome);
        if (descartado) descartando++;
        if (vazio) semConteudo++;
        pilha.push({ descartado, semConteudo: vazio });
        nomes.push(nome);
        if (descartando > 0) return;
        if (nome === "p") {
          if (profundidade === 0) {
            partes = [];
            textoForaDoNegrito = false;
          }
          profundidade++;
        } else if (profundidade > 0) {
          // Dentro de um parágrafo só entra o que a lista de texto conhece.
          if (!TEXTO.has(nome))
            violacoes.push(
              `elemento <${nome}> dentro de um parágrafo, sem regra no parser HTML (posição ${parser.startIndex})`,
            );
          else if (nome === "strong") negrito++;
          else if (nome === "br") acrescentar(" ");
        } else if (!ESTRUTURA.has(nome))
          violacoes.push(
            `elemento <${nome}> sem regra no parser HTML: nem texto mantido nem descarte explícito (posição ${parser.startIndex})`,
          );
      },
      ontext(dados) {
        if (semConteudo > 0) return;
        if (descartando > 0) {
          visivel += dados; // a frase de dedicação vale pelo que o leitor vê, esteja onde estiver
          if (dados.trim() === "") return;
          descartes.push({
            elemento: nomes.at(-1) ?? "",
            paragrafosAntes: paragrafos.length,
            amostra: compactar(dados).slice(0, 60),
            posicao: parser.startIndex,
          });
          return;
        }
        if (dados.trim() !== "" && profundidade === 0)
          violacoes.push(
            `texto fora de parágrafo, em <${nomes.at(-1) ?? ""}>: "${compactar(dados).slice(0, 60)}" (posição ${parser.startIndex})`,
          );
        acrescentar(dados);
      },
      onclosetag(nome) {
        const saiu = pilha.pop();
        nomes.pop();
        if (saiu?.semConteudo) semConteudo = Math.max(0, semConteudo - 1);
        if (saiu?.descartado) {
          descartando = Math.max(0, descartando - 1);
          return;
        }
        if (descartando > 0) return;
        if (nome === "strong" && profundidade > 0) negrito = Math.max(0, negrito - 1);
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

  return { paragrafos, texto: compactar(visivel), violacoes, descartes };
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
  const { paragrafos, violacoes, descartes } = lerParagrafosHtml(html, opcoes.maxBytes);
  if (violacoes.length > 0)
    throw new ErroHtml(
      `${violacoes.length} ocorrência(s) sem regra no parser HTML; nada é descartado em silêncio. ${violacoes.slice(0, 3).join("; ")}${violacoes.length > 3 ? "; …" : ""}`,
    );
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
  // A região dos ditos, em índices de parágrafo: do cabeçalho do dito 1 ao último parágrafo que é dito.
  let primeiro = -1;
  let ultimo = -1;
  for (const [indice, p] of paragrafos.entries()) {
    if (p.texto === "") {
      if (estado === "corpo") estado = "entre";
      continue;
    }
    if (estado === "procurando") {
      // O que vem antes do dito 1 (navegação, dedicação, legenda, Prólogo) não é dito.
      if (numeroDoCabecalho(p) === 1) {
        blocos.push({ numero: 1, textos: [] });
        estado = "corpo";
        primeiro = indice;
        ultimo = indice;
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
      ultimo = indice;
      continue;
    }
    if (estado === "corpo") {
      blocos.at(-1)?.textos.push(p.texto);
      ultimo = indice;
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

  // Descarte com texto dentro da região dos ditos seria texto da obra perdido: reprova.
  for (const d of descartes)
    if (d.paragrafosAntes > primeiro && d.paragrafosAntes <= ultimo)
      throw new ErroHtml(
        `texto descartado em <${d.elemento}> no meio da região dos ditos: "${d.amostra}" (posição ${d.posicao})`,
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
