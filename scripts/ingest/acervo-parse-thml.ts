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
//   parágrafos      cada `<p>` sob a divisão-seção (a qualquer profundidade, fora de nota e de cabeçalho)
//                   vira um parágrafo; a referência é o `id` do próprio `<p>` (ex.: ix.xvii-p5), que carrega
//                   o id da divisão da edição. `<p>` sem id é erro: o id estável é obrigatório.
//   notas           `<note>` (milhares por volume: 4.915 no ANF 1) fica FORA do texto e volta à parte, em
//                   `notas`, para o derivador conferir que nenhuma entrou num parágrafo. O `<p class=
//                   "endnote">` dentro dela nunca é parágrafo.
//   cabeçalhos      h1–h6 ficam fora do texto (repetem o título da divisão). Blocos `ThML.head` no meio do
//                   corpo (metadado por obra, no CCEL) nunca entram no texto.
//   página          `<pb n="735">` vira metadado de página da edição impressa (`paginas`), fora do texto.
//   `<br>`          vira um espaço. Divisão do nível da seção sem nenhum parágrafo (tabela, página de
//                   rosto) é pulada e relatada em `divisoesSemParagrafo`; nunca vira seção vazia.

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
};

const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const NIVEIS = new Set(["div1", "div2", "div3", "div4", "div5", "div6"]);
const CABECALHOS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

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

type ParagrafoEmLeitura = { id: string; texto: string; paginas: string[] };
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
  const notas: string[] = [];
  let corpo = false; // dentro de ThML.body
  let dentroHead = 0; // ThML.head (o principal e os de cada obra, no meio do corpo)
  let secao: SecaoEmLeitura | null = null;
  let paragrafo: ParagrafoEmLeitura | null = null;
  let profundidadeNota = 0;
  let profundidadeCabecalho = 0;
  let nota = "";
  let semId = 0;
  const pilhaDiv: string[] = [];

  const parser = new Parser(
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
        if (NIVEIS.has(nome)) {
          pilhaDiv.push(nome);
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
        if (nome === "note") {
          profundidadeNota++;
          if (profundidadeNota === 1) nota = "";
          return;
        }
        if (CABECALHOS.has(nome)) {
          profundidadeCabecalho++;
          return;
        }
        if (profundidadeNota > 0 || profundidadeCabecalho > 0) return;
        if (nome === "p" && secao) {
          // `<p>` sem id existe só nas divisões de índice do CCEL (medido nos oito volumes: 0 fora delas).
          // Não tem id estável, então nunca entra no texto: é pulado e contado, para conferência.
          if (!a.id) {
            semId++;
            return;
          }
          paragrafo = { id: a.id, texto: "", paginas: [] };
          return;
        }
        if (nome === "br" && paragrafo) paragrafo.texto += " ";
        else if (nome === "pb" && secao) {
          const n = compactar(a.n ?? "");
          if (!n) return;
          if (paragrafo) paragrafo.paginas.push(n);
          else secao.paginas.push(n);
        }
      },
      ontext(dados) {
        if (!corpo || dentroHead > 0) return;
        if (profundidadeNota > 0) nota += dados;
        else if (paragrafo && profundidadeCabecalho === 0) paragrafo.texto += dados;
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
        if (NIVEIS.has(nome)) {
          const fechado = pilhaDiv.pop();
          if (fechado === nivel && secao) {
            if (secao.paragrafos.length > 0)
              secoes.push({
                // O contrato do derivado (plano 01) exige slug kebab-case: o id da divisão vira o slug com
                // hífens no lugar dos pontos; o id original segue intacto na referência de cada parágrafo.
                slug: secao.id.replaceAll(".", "-"),
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
        if (nome === "note") {
          if (profundidadeNota === 1) {
            const t = compactar(nota);
            if (t) notas.push(t);
          }
          profundidadeNota = Math.max(0, profundidadeNota - 1);
          return;
        }
        if (CABECALHOS.has(nome)) {
          profundidadeCabecalho = Math.max(0, profundidadeCabecalho - 1);
          return;
        }
        if (profundidadeNota > 0 || profundidadeCabecalho > 0) return;
        if (nome === "p" && paragrafo) {
          const t = compactar(paragrafo.texto);
          if (t && secao)
            secao.paragrafos.push({
              ref: paragrafo.id,
              ref_inicio: null,
              ref_fim: null,
              texto: t,
              paginas: paragrafo.paginas,
            });
          paragrafo = null;
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
  return { secoes, notas, divisoesSemParagrafo, paragrafosSemId: semId };
}
