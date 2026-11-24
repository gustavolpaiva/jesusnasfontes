// Parser TEI (Perseus, canonical-greekLit) para o derivado do Acervo. Entrada: texto de TERCEIROS, tratado como
// dado não confiável: `htmlparser2` em modo SAX (`xmlMode`), que só decodifica as entidades predefinidas e
// nunca resolve entidade externa; mesmo assim, DOCTYPE e ENTITY são recusados, o tamanho de entrada tem teto e
// nenhuma expressão regular lê o XML (a única normalização é de espaços, sobre texto já extraído).
//
// Estruturas lidas (Perseus):
//   livro e unidade   `div[subtype=book][n]` > `div[subtype=section|chapter][n]` > `p` (Josefo: `section`;
//                     Tácito: `chapter`). Cada livro vira uma seção; a referência é `<livro>.<n>`.
//   obra curta        `div[subtype=section][n]` > `p`, sem livro (Luciano). A obra inteira vira UMA seção de slug
//                     `texto` e a referência é o próprio `n`.
// O `n` da unidade é o PRIMEIRO parágrafo da numeração de Niese que a unidade de Whiston contém; a faixa vai até
// o `n` da unidade seguinte menos 1 (a última unidade do livro, e as de numeração fora de ordem, ficam sem faixa).
// `note` (nota de editor) e `head` ficam fora do texto; as notas voltam à parte para conferir que nenhuma
// entrou num parágrafo. `q` vira aspas curvas (o arquivo guarda a citação como elemento, sem o sinal); verso (`l`)
// e marcador de página (`pb`) dentro do `p` não deixam nada além do texto; lacuna (`gap`) entra como o sinal
// que a própria edição usa (o atributo `rend`).

import { Parser } from "htmlparser2";
import { TETO_BRUTO_BYTES } from "./acervo-origens";

export class ErroTei extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroTei";
  }
}

export type ParagrafoTei = {
  ref: string;
  ref_inicio: number | null;
  ref_fim: number | null;
  texto: string;
};
export type SecaoTei = { slug: string; titulo: string; ordem: number; paragrafos: ParagrafoTei[] };
export type ResultadoTei = { secoes: SecaoTei[]; notas: string[] };
export type OpcoesTei = {
  /** Rótulo do título da seção: "Book" dá "Book 18". */
  rotuloLivro?: string;
  /** Título da seção única de uma obra sem livros (padrão "Text"). */
  tituloObraUnica?: string;
  /** Teto do tamanho de entrada em bytes (padrão: o do registro). */
  maxBytes?: number;
};

type Pendente = { n: string; textos: string[] };
type LivroEmLeitura = { n: string; secoes: Pendente[] };

const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
const inteiro = (s: string): number | null => (/^[0-9]+$/.test(s) ? Number(s) : null);
// Depois de uma destas, uma aspa de abertura não leva espaço antes.
const ABRE = new Set(["", " ", "(", "[", "“", "‘"]);

export function parsearTei(xml: string, opcoes: OpcoesTei = {}): ResultadoTei {
  const teto = opcoes.maxBytes ?? TETO_BRUTO_BYTES;
  if (Buffer.byteLength(xml, "utf8") > teto)
    throw new ErroTei(`arquivo acima do teto de entrada (${teto} bytes)`);
  if (xml.includes("<!DOCTYPE") || xml.includes("<!ENTITY"))
    throw new ErroTei("DOCTYPE e ENTITY não são aceitos no arquivo de origem");
  const rotulo = opcoes.rotuloLivro ?? "Book";

  const livros: LivroEmLeitura[] = [];
  const notas: string[] = [];
  let livro: LivroEmLeitura | null = null;
  let secao: Pendente | null = null;
  let corpo = false; // dentro do `text`: o cabeçalho não entra
  let profundidadeNota = 0;
  let profundidadeHead = 0;
  let profundidadeP = 0;
  let nota = "";
  let atual = "";
  const pilhaDiv: ("livro" | "secao" | "outro")[] = [];
  // Obra sem livros: as unidades ficam num livro implícito de `n` vazio, que nunca fecha.
  const IMPLICITO = "";

  const acrescentar = (texto: string) => {
    atual += texto;
  };

  const parser = new Parser(
    {
      onopentag(nome, a) {
        if (nome === "text") corpo = true;
        if (!corpo) return;
        if (nome === "div") {
          if (a.subtype === "book" && a.n) {
            livro = { n: a.n, secoes: [] };
            livros.push(livro);
            pilhaDiv.push("livro");
          } else if ((a.subtype === "section" || a.subtype === "chapter") && a.n) {
            if (!livro) {
              if (livros.some((l) => l.n !== IMPLICITO))
                throw new ErroTei(`unidade ${a.n} fora de um livro, depois de livros explícitos`);
              livro = livros[0] ?? { n: IMPLICITO, secoes: [] };
              if (livros.length === 0) livros.push(livro);
            }
            secao = { n: a.n, textos: [] };
            livro.secoes.push(secao);
            pilhaDiv.push("secao");
          } else pilhaDiv.push("outro");
          return;
        }
        if (nome === "note") {
          profundidadeNota++;
          if (profundidadeNota === 1) nota = "";
        } else if (nome === "head") profundidadeHead++;
        else if (nome === "p" && secao && profundidadeNota === 0 && profundidadeHead === 0) {
          profundidadeP++;
          if (profundidadeP === 1) atual = "";
        } else if (nome === "q" && profundidadeP > 0 && profundidadeNota === 0) {
          const ultimo = atual.slice(-1);
          if (!ABRE.has(ultimo)) acrescentar(" ");
          acrescentar("“");
        } else if (nome === "lb" && profundidadeP > 0 && profundidadeNota === 0) acrescentar(" ");
        else if (nome === "gap" && profundidadeP > 0 && profundidadeNota === 0) {
          const sinal = compactar(a.rend ?? "");
          if (sinal) acrescentar(` ${sinal} `);
        }
      },
      ontext(dados) {
        if (!corpo) return;
        if (profundidadeNota > 0) nota += dados;
        else if (profundidadeP > 0 && profundidadeHead === 0) acrescentar(dados);
      },
      onclosetag(nome) {
        if (!corpo) return;
        if (nome === "text") {
          corpo = false;
          return;
        }
        if (nome === "div") {
          const fechado = pilhaDiv.pop();
          if (fechado === "secao") secao = null;
          else if (fechado === "livro") {
            livro = null;
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
        } else if (nome === "head") profundidadeHead = Math.max(0, profundidadeHead - 1);
        else if (nome === "q" && profundidadeP > 0 && profundidadeNota === 0) acrescentar("”");
        else if (nome === "p" && profundidadeP > 0 && profundidadeNota === 0) {
          profundidadeP--;
          if (profundidadeP === 0 && secao) {
            const t = compactar(atual);
            if (t) secao.textos.push(t);
            atual = "";
          }
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(xml);
  parser.end();

  if (livros.length === 0)
    throw new ErroTei(
      "nenhum livro (div subtype=book) nem unidade (section ou chapter) no arquivo",
    );

  const secoes: SecaoTei[] = [];
  for (const [i, l] of livros.entries()) {
    const implicito = l.n === IMPLICITO;
    const ordem = implicito ? 1 : inteiro(l.n);
    if (ordem === null) throw new ErroTei(`livro ${i + 1}: o atributo n não é um número`);
    const paragrafos: ParagrafoTei[] = [];
    for (const [j, s] of l.secoes.entries()) {
      if (s.textos.length === 0) continue;
      const inicio = inteiro(s.n);
      const seguinte = l.secoes[j + 1];
      const proximo = seguinte ? inteiro(seguinte.n) : null;
      const anterior = j > 0 ? inteiro((l.secoes[j - 1] as Pendente).n) : null;
      // A faixa só vale com a vizinhança em ordem crescente: o Perseus tem uma unidade fora de ordem
      // (17.13, entre 17.332 e 17.342), e nela e na anterior uma faixa seria número inventado.
      const comFaixa =
        inicio !== null &&
        proximo !== null &&
        proximo > inicio &&
        (j === 0 || (anterior !== null && anterior < inicio));
      paragrafos.push({
        ref: implicito ? s.n : `${l.n}.${s.n}`,
        ref_inicio: comFaixa ? inicio : null,
        ref_fim: comFaixa ? (proximo as number) - 1 : null,
        // Mais de um `p` na mesma unidade da obra: uma só referência, parágrafos unidos por um espaço.
        texto: s.textos.join(" "),
      });
    }
    if (paragrafos.length === 0) throw new ErroTei(`livro ${l.n}: sem nenhum parágrafo`);
    if (implicito)
      secoes.push({ slug: "texto", titulo: opcoes.tituloObraUnica ?? "Text", ordem, paragrafos });
    else secoes.push({ slug: l.n, titulo: `${rotulo} ${l.n}`, ordem, paragrafos });
  }
  return { secoes, notas };
}
