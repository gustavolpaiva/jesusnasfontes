// Parser ThML (CCEL: Ante-Nicene Fathers, NPNF e a coleção de Lightfoot) para o derivado do Acervo.
// Entrada: texto de TERCEIROS, tratado como dado não confiável: `htmlparser2` em modo SAX (`xmlMode`), que
// só decodifica as entidades predefinidas e nunca resolve entidade externa nem busca a DTD; mesmo assim,
// ENTITY e DOCTYPE com subconjunto interno são recusados e o tamanho de entrada tem teto. Os arquivos reais
// do CCEL trazem DOCTYPE com DTD EXTERNA (anf01…anf09 não; npnf201 e lightfoot/fathers sim) e só a entidade
// `&amp;` — medido nos oito arquivos. Nenhuma expressão regular lê o XML (só texto já extraído).
//
// Estrutura lida (medida nos oito volumes):
//   divisões        div1 > div2 > div3 > div4, todas com `id` estável dentro do sha256 fixado e `title`
//                   (ex.: div2 id="ix.xvii", a carta de Mara bar Serapião no ANF 8). O registro diz, por
//                   arquivo, qual nível vira SEÇÃO (`divisao_secao`); o id da divisão é o slug da seção.
//   parágrafos      o texto da obra vive em TRÊS blocos, cada um com `id` estável (a referência do parágrafo):
//                   `<p>`, `<verse>` (um parágrafo por estrofe, com as linhas `<l>` unidas por " / ") e `<li>`
//                   de lista fora do índice. Bloco sem id é erro, salvo `<p>` (ver abaixo).
//   notas           `<note>` (milhares por volume: 4.915 no ANF 1) fica FORA do texto e volta à parte, em
//                   `notas`, para o derivador conferir que nenhuma entrou num parágrafo. O `<p class=
//                   "endnote">` dentro dela nunca é parágrafo.
//   cabeçalhos      h1–h6 ficam fora do texto (repetem o título da divisão). Blocos `ThML.head` no meio do
//                   corpo (metadado por obra, no CCEL) nunca entram no texto.
//   índice          `<div class="Index">` (índice remissivo do volume: lista de referências e de palavras
//                   gregas e hebraicas, com número de página) fica fora, por inteiro.
//   página          `<pb n="735">` vira metadado de página da edição impressa (`paginas`), fora do texto.
//   `<br>`          vira um espaço. Divisão do nível da seção sem nenhum parágrafo (tabela, página de
//                   rosto) é pulada e relatada em `divisoesSemParagrafo`; nunca vira seção vazia.
//
// FALHA EM VOZ ALTA (a classe do defeito do `<verse>`, que o parser largava sem sinal e tirou do derivado a
// Oração do Senhor da Didaqué): todo elemento do corpo está em UMA destas listas, e o que não está em
// nenhuma reprova a derivação com o nome do elemento, a divisão e a linha. Texto que cai fora de um bloco
// (e fora de nota, cabeçalho e índice) também reprova. Nada some em silêncio.
//   ELEMENTOS_BLOCO       onde o texto vive (vira parágrafo): p, verse, li
//   ELEMENTOS_TEXTO       entram no texto do bloco, sem marca: i, span, a, q, scripRef, sup, sub, l (linha de verso)
//   ELEMENTOS_ESTRUTURA   contêineres, sem texto próprio: div1–div6, div, ol, ul, table, tr, td
//   ELEMENTOS_DESCARTADOS apparatus fora do texto, por regra explícita: note, h1–h6, ThML.head, div.Index;
//                         e as marcas vazias pb, hr, index, insertIndex, scripCom e br (que vira espaço)

import { Parser } from "htmlparser2";
import { TETO_BRUTO_BYTES } from "./acervo-origens";
import type { ParagrafoTei, SecaoTei } from "./acervo-parse-tei";

export class ErroThml extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroThml";
  }
}

export type NivelDivisao = "div1" | "div2" | "div3" | "div4";

/** O que o registro diz sobre o arquivo (formato `thml`): qual nível de divisão vira seção. */
export type ConfigThml = {
  divisaoSecao: NivelDivisao;
};

export type OpcoesThml = ConfigThml & {
  /** Teto do tamanho de entrada em bytes (padrão: o do registro). */
  maxBytes?: number;
};

export type ParagrafoThml = ParagrafoTei & {
  /** Páginas da edição impressa abertas dentro do parágrafo (`<pb n>`), como metadado. */
  paginas: string[];
};
export type SecaoThml = Omit<SecaoTei, "paragrafos"> & {
  /** O id pontuado da divisão da edição (ex.: "ii.xii"): é ele que o registro lista em `divisoes`. */
  id: string;
  paragrafos: ParagrafoThml[];
  /** Páginas abertas na seção fora de qualquer parágrafo. */
  paginas: string[];
};
export type ResultadoThml = {
  secoes: SecaoThml[];
  notas: string[];
  /** Ids das divisões do nível da seção sem nenhum parágrafo (tabelas, índices, páginas de rosto), puladas. */
  divisoesSemParagrafo: string[];
  /** `<p>` sem id (não têm id estável: só as divisões de índice do CCEL os têm), pulados e contados. */
  paragrafosSemId: number;
  /** Blocos de texto fora de qualquer divisão do nível da seção (página de rosto do volume), por id. */
  blocosForaDeSecao: string[];
};

/** O separador das linhas de um `<verse>`: a convenção do verso corrido em prosa. */
export const SEPARADOR_DE_LINHA = " / ";

const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
/** O id pontuado da divisão da edição (ex.: "ii.xii") vira o slug kebab-case que o contrato do derivado exige. */
export const slugDaDivisao = (id: string) => id.replaceAll(".", "-");
const NIVEIS = new Set(["div1", "div2", "div3", "div4", "div5", "div6"]);
const CABECALHOS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const ELEMENTOS_BLOCO: readonly string[] = ["p", "verse", "li"];
export const ELEMENTOS_TEXTO: readonly string[] = [
  "i",
  "span",
  "a",
  "q",
  "scripRef",
  "sup",
  "sub",
  "l",
];
export const ELEMENTOS_ESTRUTURA: readonly string[] = [
  "div1",
  "div2",
  "div3",
  "div4",
  "div5",
  "div6",
  "div",
  "ol",
  "ul",
  "table",
  "tr",
  "td",
];
export const ELEMENTOS_DESCARTADOS: readonly string[] = [
  "note",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ThML.head",
  "pb",
  "hr",
  "index",
  "insertIndex",
  "scripCom",
  "br",
];
const CONHECIDOS = new Set([
  ...ELEMENTOS_BLOCO,
  ...ELEMENTOS_TEXTO,
  ...ELEMENTOS_ESTRUTURA,
  ...ELEMENTOS_DESCARTADOS,
]);

/**
 * Conferência de entrada, LINEAR: teto, ENTITY recusado, DOCTYPE só sem subconjunto interno. Como a linha
 * pode ser longa, cada posição é visitada uma vez (o laço interno para no primeiro ">" ou "<").
 */
function conferirEntrada(xml: string, teto: number): void {
  if (Buffer.byteLength(xml, "utf8") > teto)
    throw new ErroThml(`arquivo acima do teto de entrada (${teto} bytes)`);
  const min = xml.toLowerCase();
  if (min.includes("<!entity")) throw new ErroThml("ENTITY não é aceito no arquivo de origem");
  let i = 0;
  for (;;) {
    const declaracao = min.indexOf("<!doctype", i);
    if (declaracao < 0) return;
    let j = declaracao + "<!doctype".length;
    for (; j < min.length; j++) {
      const c = min[j] as string;
      if (c === "[")
        throw new ErroThml("DOCTYPE com subconjunto interno não é aceito no arquivo de origem");
      if (c === ">" || c === "<") break;
    }
    if (j >= min.length) return;
    i = j;
  }
}

type BlocoEmLeitura = {
  /** O elemento que abriu o bloco: p, verse ou li. */
  nome: "p" | "verse" | "li";
  id: string;
  /** Texto corrido (p e li). */
  texto: string;
  /** Linhas já fechadas de um verso. */
  linhas: string[];
  /** A linha de verso aberta (`<l>`), ou null fora dela. */
  linha: string | null;
  paginas: string[];
  /** `<p>` sem id dentro de uma seção: lido para o texto não vazar, mas nunca vira parágrafo. */
  semId: boolean;
};
type SecaoEmLeitura = {
  id: string;
  titulo: string;
  paragrafos: ParagrafoThml[];
  paginas: string[];
};

export function parsearThml(xml: string, opcoes: OpcoesThml): ResultadoThml {
  conferirEntrada(xml, opcoes.maxBytes ?? TETO_BRUTO_BYTES);
  const nivel = opcoes.divisaoSecao;

  const secoes: SecaoThml[] = [];
  const idsVistos = new Set<string>();
  const divisoesSemParagrafo: string[] = [];
  const blocosForaDeSecao: string[] = [];
  const notas: string[] = [];
  let corpo = false; // dentro de ThML.body
  let dentroHead = 0; // ThML.head (o principal e os de cada obra, no meio do corpo)
  let secao: SecaoEmLeitura | null = null;
  let bloco: BlocoEmLeitura | null = null;
  let profundidadeNota = 0;
  let profundidadeCabecalho = 0;
  let profundidadeIndice = 0; // dentro de <div class="Index"> (todo elemento abre e fecha aqui dentro)
  let nota = "";
  let semId = 0;
  const pilhaDiv: string[] = [];
  let divAtual = "";

  const linhaDe = (indice: number) => {
    let linha = 1;
    for (let i = xml.indexOf("\n"); i >= 0 && i < indice; i = xml.indexOf("\n", i + 1)) linha++;
    return linha;
  };
  const falhar = (mensagem: string): never => {
    const onde = divAtual ? `divisão ${divAtual}` : "fora de divisão";
    throw new ErroThml(`${mensagem} (${onde}, linha ${linhaDe(parser.startIndex)})`);
  };

  const fecharBloco = () => {
    const b = bloco;
    bloco = null;
    if (!b) return;
    if (b.semId) {
      semId++;
      return;
    }
    const texto = b.nome === "verse" ? b.linhas.join(SEPARADOR_DE_LINHA) : compactar(b.texto);
    if (!texto) return;
    if (!secao) {
      blocosForaDeSecao.push(b.id);
      return;
    }
    secao.paragrafos.push({
      ref: b.id,
      ref_inicio: null,
      ref_fim: null,
      texto,
      paginas: b.paginas,
    });
  };

  const parser: Parser = new Parser(
    {
      onopentag(nome, a) {
        if (nome === "ThML.body") {
          corpo = true;
          return;
        }
        if (nome === "ThML.head") {
          dentroHead++;
          return;
        }
        if (!corpo || dentroHead > 0) return;
        // Índice remissivo do volume: descartado por inteiro (regra explícita).
        if (profundidadeIndice > 0) {
          profundidadeIndice++;
          return;
        }
        if (nome === "div" && a.class === "Index") {
          profundidadeIndice = 1;
          return;
        }
        if (nome === "note") {
          profundidadeNota++;
          if (profundidadeNota === 1) nota = "";
          return;
        }
        if (profundidadeNota > 0) return;
        if (CABECALHOS.has(nome)) {
          profundidadeCabecalho++;
          return;
        }
        if (profundidadeCabecalho > 0) return;
        if (NIVEIS.has(nome)) {
          if (bloco) falhar(`divisão <${nome}> dentro de um bloco de texto <${bloco.nome}>`);
          pilhaDiv.push(nome);
          if (a.id) divAtual = a.id;
          if (nome !== nivel) return;
          if (secao) {
            throw new ErroThml(
              `divisão ${a.id ?? "(sem id)"} do nível ${nivel} aninhada em ${secao.id}: estrutura inesperada`,
            );
          }
          if (!a.id)
            throw new ErroThml(`divisão ${nivel} sem id: o id estável da edição é obrigatório`);
          if (idsVistos.has(a.id)) throw new ErroThml(`id de divisão repetido no arquivo: ${a.id}`);
          idsVistos.add(a.id);
          const titulo = compactar(a.title ?? "");
          if (!titulo) throw new ErroThml(`divisão ${a.id} sem título (atributo title)`);
          secao = { id: a.id, titulo, paragrafos: [], paginas: [] };
          return;
        }
        if (nome === "p" || nome === "verse" || nome === "li") {
          if (bloco) falhar(`<${nome}> dentro de um bloco de texto <${bloco.nome}>`);
          // `<p>` sem id existe só nas divisões de índice do CCEL (medido nos oito volumes: 0 fora delas).
          // Não tem id estável, então nunca entra no texto: é pulado e contado, para conferência. Verso e
          // item de lista são texto da obra e SEM id é erro (nunca um corte silencioso).
          const pulado = nome === "p" && !a.id && secao !== null;
          if (!a.id && nome !== "p")
            falhar(`<${nome}> sem id: o id estável da edição é obrigatório`);
          bloco = {
            nome,
            id: a.id ?? "(sem id)",
            texto: "",
            linhas: [],
            linha: null,
            paginas: [],
            semId: pulado,
          };
          return;
        }
        if (nome === "l") {
          if (!bloco || bloco.nome !== "verse")
            falhar("<l> fora de <verse>: linha de verso sem estrofe");
          else {
            if (bloco.linha !== null) falhar("<l> dentro de <l>");
            bloco.linha = "";
          }
          return;
        }
        if (nome === "br") {
          if (bloco) {
            if (bloco.linha !== null) bloco.linha += " ";
            else bloco.texto += " ";
          }
          return;
        }
        if (nome === "pb") {
          const n = compactar(a.n ?? "");
          if (!n) return;
          if (bloco) bloco.paginas.push(n);
          else if (secao) secao.paginas.push(n);
          return;
        }
        if (!CONHECIDOS.has(nome))
          falhar(
            `elemento <${nome}${a.id ? ` id="${a.id}"` : ""}> sem regra no parser ThML: nem texto mantido nem descarte explícito`,
          );
      },
      ontext(dados) {
        if (!corpo || dentroHead > 0) return;
        if (profundidadeIndice > 0) return;
        if (profundidadeNota > 0) {
          nota += dados;
          return;
        }
        if (profundidadeCabecalho > 0) return;
        if (bloco) {
          if (bloco.nome === "verse") {
            if (bloco.linha !== null) bloco.linha += dados;
            else if (dados.trim() !== "")
              falhar(`texto fora de <l> dentro de <verse id="${bloco.id}">`);
          } else bloco.texto += dados;
          return;
        }
        if (dados.trim() !== "")
          falhar(`texto fora de qualquer bloco (p, verse, li): "${compactar(dados).slice(0, 60)}"`);
      },
      onclosetag(nome) {
        if (nome === "ThML.body") {
          corpo = false;
          return;
        }
        if (nome === "ThML.head") {
          dentroHead = Math.max(0, dentroHead - 1);
          return;
        }
        if (!corpo || dentroHead > 0) return;
        if (profundidadeIndice > 0) {
          profundidadeIndice--;
          return;
        }
        if (profundidadeNota > 0) {
          if (nome === "note") {
            if (profundidadeNota === 1) {
              const t = compactar(nota);
              if (t) notas.push(t);
            }
            profundidadeNota--;
          }
          return;
        }
        if (profundidadeCabecalho > 0) {
          if (CABECALHOS.has(nome)) profundidadeCabecalho--;
          return;
        }
        if (NIVEIS.has(nome)) {
          const fechado = pilhaDiv.pop();
          if (fechado === nivel && secao) {
            if (secao.paragrafos.length > 0)
              secoes.push({
                // O contrato do derivado (plano 01) exige slug kebab-case: o id da divisão vira o slug com
                // hífens no lugar dos pontos; o id original segue na própria seção e na referência de cada
                // parágrafo — é ele que o registro lista em `divisoes` quando o volume tem várias obras.
                id: secao.id,
                slug: slugDaDivisao(secao.id),
                titulo: secao.titulo,
                ordem: secoes.length + 1,
                paragrafos: secao.paragrafos,
                paginas: secao.paginas,
              });
            else divisoesSemParagrafo.push(secao.id);
            secao = null;
          }
          return;
        }
        if (bloco && nome === bloco.nome) {
          fecharBloco();
          return;
        }
        if (nome === "l" && bloco && bloco.nome === "verse" && bloco.linha !== null) {
          const t = compactar(bloco.linha);
          if (t) bloco.linhas.push(t);
          bloco.linha = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();

  if (secoes.length === 0)
    throw new ErroThml(
      `nenhuma divisão ${nivel} com parágrafo no arquivo (o nível da seção vem do registro: divisao_secao)`,
    );
  return { secoes, notas, divisoesSemParagrafo, paragrafosSemId: semId, blocosForaDeSecao };
}
