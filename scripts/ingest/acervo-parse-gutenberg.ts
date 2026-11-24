// Parser de texto do Project Gutenberg para o derivado do Acervo (plano 02-27). Entrada: texto de TERCEIROS,
// tratado como dado não confiável. Lê-se LINHA A LINHA, com uma máquina de estados simples: nenhuma expressão
// regular é aplicada ao texto inteiro de uma só vez (cada uma examina uma linha, ou o trecho já extraído).
//
// Bordas: tudo o que vem antes do marcador `*** START OF … PROJECT GUTENBERG EBOOK … ***` e depois do marcador
// `*** END OF … ***` fica fora (cabeçalho, licença, aviso da Fundação). `separarGutenberg` devolve os três pedaços:
// é também onde o verificador de licença lê as bordas (`acervo-licenca`).
//
// Estrutura lida no arquivo real (#2811, Cartas de Plínio, Melmoth):
//   parte      uma linha só em caixa alta (título da parte), seguida do cabeçalho da carta I e do texto dela.
//              O índice e a introdução dos produtores repetem os mesmos títulos e cabeçalhos, um por linha e sem
//              texto entre eles: por isso uma parte só começa quando o cabeçalho I é seguido de TEXTO.
//   carta      `XCVII To THE EMPEROR TRAJAN[1066]`, `I -- To SEPTITTUS`, `XCVIII -- TRAJAN TO PLINY`,
//              `LX VII -- To MACER` (espaço no meio do numeral). Cada carta é UM parágrafo; o cabeçalho
//              (destinatário) fica fora, como o `head` do TEI; as linhas de cada bloco são unidas e os blocos
//              internos (linha em branco: citação, edital) são unidos por um espaço.
//   numeração  conferida na ordem: cada cabeçalho tem de ser a carta seguinte. Carta que falta no arquivo é
//              relatada em `ausentes` (nunca inventada nem ignorada); número repetido ou regressivo reprova.
//              Como as duas partes recomeçam em I, o rótulo de cada carta leva o slug da parte (`trajano.XCVII`),
//              e a tabela de correspondência do registro troca pelo número moderno as que ela listar.
//   notas      bloco `FOOTNOTES TO …` depois da última carta de cada parte; cada nota começa em `N (return) [`
//              (a primeira vem colada ao título do bloco). Vão à parte, em `notas`.
//   marcas     marcador de nota `[1066]` e as etiquetas `<a …>` que a conversão deixou (partidas em duas linhas)
//              saem do texto. Outra marcação HTML reprova em vez de vazar para o texto.

import { TETO_BRUTO_BYTES } from "./acervo-origens";
import type { ParagrafoTei, SecaoTei } from "./acervo-parse-tei";

export class ErroGutenberg extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroGutenberg";
  }
}

/** Os três pedaços do arquivo: antes do marcador de início, o corpo, e depois do marcador de fim. */
export type PartesGutenberg = { inicio: string; corpo: string; fim: string };

const MARCA_INICIO = /^\*\*\* START OF (?:THE|THIS) PROJECT GUTENBERG E(?:BOOK|TEXT) .+ \*\*\*$/;
const MARCA_FIM = /^\*\*\* END OF (?:THE|THIS) PROJECT GUTENBERG E(?:BOOK|TEXT) .+ \*\*\*$/;

const semCR = (l: string) => (l.endsWith("\r") ? l.slice(0, -1) : l);
const compactar = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/**
 * Separa o arquivo pelas duas marcas do próprio arquivo: a PRIMEIRA de início e a ÚLTIMA de fim, de modo que uma
 * marca citada dentro do corpo não desloque as bordas. Sem uma delas não há borda para ler a licença.
 */
export function separarGutenberg(texto: string): PartesGutenberg {
  const linhas = texto.split("\n");
  let iInicio = -1;
  let iFim = -1;
  for (const [i, bruta] of linhas.entries()) {
    const l = semCR(bruta);
    if (iInicio < 0) {
      // A marca de ordem de byte (U+FEFF) só pode estar na primeira linha.
      if (MARCA_INICIO.test(i === 0 ? l.replace(/^\uFEFF/, "") : l)) iInicio = i;
    } else if (MARCA_FIM.test(l)) iFim = i; // a ÚLTIMA marca de fim é a do arquivo; uma citada no corpo não fecha a borda
  }
  if (iInicio < 0)
    throw new ErroGutenberg(
      "arquivo sem o marcador de início do Project Gutenberg (*** START OF … ***): não há borda para ler a licença",
    );
  if (iFim < 0)
    throw new ErroGutenberg(
      "arquivo sem o marcador de fim do Project Gutenberg (*** END OF … ***): não há borda para ler a licença",
    );
  return {
    inicio: linhas.slice(0, iInicio).join("\n"),
    corpo: linhas.slice(iInicio + 1, iFim).join("\n"),
    fim: linhas.slice(iFim + 1).join("\n"),
  };
}

// ───────────────────────── numeração romana ─────────────────────────

const ALGARISMOS: readonly (readonly [string, number])[] = [
  ["M", 1000],
  ["CM", 900],
  ["D", 500],
  ["CD", 400],
  ["C", 100],
  ["XC", 90],
  ["L", 50],
  ["XL", 40],
  ["X", 10],
  ["IX", 9],
  ["V", 5],
  ["IV", 4],
  ["I", 1],
];
const VALOR: Readonly<Record<string, number>> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
};

function paraRomano(n: number): string {
  let resto = n;
  let saida = "";
  for (const [letras, valor] of ALGARISMOS) {
    while (resto >= valor) {
      saida += letras;
      resto -= valor;
    }
  }
  return saida;
}

/** Valor de um numeral romano em caixa alta e na forma canônica; `null` se não é um numeral bem formado. */
function valorRomano(rotulo: string): number | null {
  if (rotulo.length === 0) return null;
  let total = 0;
  for (let i = 0; i < rotulo.length; i++) {
    const atual = VALOR[rotulo[i] as string] ?? 0;
    const proximo = i + 1 < rotulo.length ? (VALOR[rotulo[i + 1] as string] ?? 0) : 0;
    if (atual === 0) return null;
    total += atual < proximo ? -atual : atual;
  }
  if (total <= 0) return null;
  return paraRomano(total) === rotulo ? total : null;
}

// ───────────────────────── linhas do corpo ─────────────────────────

const TITULO_DE_PARTE = /^[A-Z][A-Z ,.'-]{7,}$/;
const INICIO_DE_NOTAS = /^FOOTNOTES/;
// A primeira nota vem colada ao título do bloco, e pode não ter nada depois do colchete na mesma linha
// ("… TRAJAN 1001 (return) [" e o texto nas linhas seguintes).
const INICIO_DE_NOTA = /^(?:FOOTNOTES\D*?)?(\d+[a-z]?) \(return\) \[ ?(.*)$/;
/** Cabeçalho de carta: numeral (talvez com espaço no meio), traço opcional e o destinatário. */
const CABECALHO_DE_CARTA = /^([IVXLCDM][IVXLCDM ]{0,17}) +(?:-- +)?(?:To|TO|TRAJAN TO) /;
/** Marca de HTML que sobrou depois da limpeza: este parser não sabe o que ela significa. */
const MARCA_DE_HTML = /<\/?[a-zA-Z]/;

const emBranco = (l: string) => l.trim() === "";

/** O rótulo do cabeçalho de carta (numeral sem espaços), ou `null` se a linha não é um cabeçalho. */
function rotuloDaCarta(l: string): string | null {
  const m = CABECALHO_DE_CARTA.exec(l);
  return m ? (m[1] as string).replace(/ /g, "") : null;
}

type EstadoEtiqueta = { aberta: boolean };

/**
 * Tira de UMA linha as marcas que não são da obra: a etiqueta `<a …>` que a conversão deixou (pode começar numa
 * linha e acabar na seguinte: daí o estado) e o marcador de nota `[1066]`. Devolve a linha limpa.
 */
function semMarcas(linha: string, estado: EstadoEtiqueta): string {
  let resto = linha;
  let saida = "";
  if (estado.aberta) {
    const fim = resto.indexOf(">");
    if (fim < 0) return "";
    resto = resto.slice(fim + 1);
    estado.aberta = false;
  }
  for (;;) {
    const abreA = resto.indexOf("<a ");
    const fechaA = resto.indexOf("</a");
    const abre = abreA >= 0 && fechaA >= 0 ? Math.min(abreA, fechaA) : Math.max(abreA, fechaA);
    if (abre < 0) {
      saida += resto;
      break;
    }
    saida += resto.slice(0, abre);
    const fim = resto.indexOf(">", abre);
    if (fim < 0) {
      estado.aberta = true;
      break;
    }
    resto = resto.slice(fim + 1);
  }
  return saida.replace(/\[\d+\]/g, "");
}

// ───────────────────────── parser ─────────────────────────

export type ConfigGutenberg = {
  /** Estrutura da obra dentro do arquivo. */
  estrutura: "cartas";
  /** Slug de cada parte, na ordem em que as partes aparecem no arquivo. */
  secoes: readonly string[];
  /** Tabela de correspondência: `<slug da parte>.<rótulo no arquivo>` → referência moderna. */
  correspondencia?: Readonly<Record<string, string>>;
};

export type OpcoesGutenberg = ConfigGutenberg & {
  /** Teto do tamanho de entrada em bytes (padrão: o do registro). */
  maxBytes?: number;
};

export type ResultadoGutenberg = {
  secoes: SecaoTei[];
  /** Notas do tradutor lidas à parte, para o derivador conferir que nenhuma entrou num parágrafo. */
  notas: string[];
  /** Unidades (`<slug da parte>.<rótulo>`) que a numeração do arquivo salta: a origem não as traz. */
  ausentes: string[];
  /** Unidades fora da tabela de correspondência, que ficaram com a numeração da própria origem. */
  foraDaTabela: string[];
};

type CartaEmLeitura = { rotulo: string; valor: number; blocos: string[] };
type ParteEmLeitura = { slug: string; titulo: string; cartas: CartaEmLeitura[] };
type Estado = "antes" | "parte" | "carta" | "notas";

export function parsearGutenberg(texto: string, opcoes: OpcoesGutenberg): ResultadoGutenberg {
  const teto = opcoes.maxBytes ?? TETO_BRUTO_BYTES;
  if (Buffer.byteLength(texto, "utf8") > teto)
    throw new ErroGutenberg(`arquivo acima do teto de entrada (${teto} bytes)`);
  if (opcoes.estrutura !== "cartas")
    throw new ErroGutenberg(`estrutura "${opcoes.estrutura}" sem parser neste pipeline`);
  if (opcoes.secoes.length === 0)
    throw new ErroGutenberg(
      "formato gutenberg exige o slug de cada parte do arquivo no registro (secoes)",
    );

  const linhas = separarGutenberg(texto).corpo.split("\n").map(semCR);
  const total = linhas.length;
  const partes: ParteEmLeitura[] = [];
  const notas: string[] = [];
  const ausentes: string[] = [];
  const foraDaTabela: string[] = [];
  let estado: Estado = "antes";
  let parte: ParteEmLeitura | null = null;
  let carta: CartaEmLeitura | null = null;
  let bloco: string[] = [];
  let nota: string[] | null = null;
  // O estado da etiqueta é de cada carta: nasce com ela e é zerado a cada cabeçalho.
  let etiqueta: EstadoEtiqueta = { aberta: false };
  // A carta aberta só é trocada dentro das funções abaixo: lê-se por esta função, para o tipo declarado valer.
  const cartaAberta = () => carta;

  const fecharBloco = () => {
    if (bloco.length > 0 && carta) carta.blocos.push(compactar(bloco.join(" ")));
    bloco = [];
  };
  const fecharCarta = () => {
    fecharBloco();
    if (carta && parte) {
      if (carta.blocos.length === 0)
        throw new ErroGutenberg(`carta ${parte.slug}.${carta.rotulo} sem texto nenhum`);
      parte.cartas.push(carta);
    }
    carta = null;
  };
  const fecharNota = () => {
    if (nota) {
      const t = compactar(nota.join(" ")).replace(/\]+$/, "");
      if (t) notas.push(t);
    }
    nota = null;
  };
  /** Uma linha do bloco de notas: começa uma nota, continua a aberta, ou fecha a aberta. */
  const tratarNota = (l: string) => {
    const m = INICIO_DE_NOTA.exec(l);
    if (m) {
      fecharNota();
      nota = [m[2] as string];
    } else if (!nota) return;
    else nota.push(l);
    if (nota && l.endsWith("]")) fecharNota();
  };
  const iniciarCarta = (rotulo: string, numero: number) => {
    if (!parte) throw new ErroGutenberg(`cabeçalho de carta "${rotulo}" fora de uma parte`);
    const valor = valorRomano(rotulo);
    if (valor === null)
      throw new ErroGutenberg(
        `cabeçalho de carta com numeral mal formado: "${rotulo}" (linha ${numero} do corpo)`,
      );
    // A carta aberta ainda não foi para a lista: é ela a anterior, e não a última já fechada.
    const anterior = carta?.valor ?? parte.cartas.at(-1)?.valor ?? 0;
    if (anterior === 0 && valor !== 1)
      throw new ErroGutenberg(
        `a parte "${parte.titulo}" tem de começar pela carta I, e começa em ${rotulo}`,
      );
    if (valor <= anterior)
      throw new ErroGutenberg(
        `carta ${parte.slug}.${rotulo} fora de sequência: depois de ${paraRomano(anterior)} (linha ${numero} do corpo)`,
      );
    // O que a numeração do arquivo salta é relatado, com o numeral canônico: a origem não traz a carta.
    for (let v = anterior + 1; v < valor; v++) ausentes.push(`${parte.slug}.${paraRomano(v)}`);
    fecharCarta();
    carta = { rotulo, valor, blocos: [] };
    bloco = [];
    etiqueta = { aberta: false };
  };
  /**
   * Título de parte: linha em caixa alta, seguida do cabeçalho da carta I e de texto (não de outro cabeçalho). É
   * o que separa o corpo do índice, que repete os mesmos títulos um por linha. Título seguido de qualquer outra
   * coisa (texto solto, carta que não é a I, carta I sem texto) não é parte: o arquivo reprova lá no fim.
   */
  const ehInicioDeParte = (i: number): boolean => {
    const l = linhas[i] as string;
    if (!TITULO_DE_PARTE.test(l) || INICIO_DE_NOTAS.test(l)) return false;
    let j = i + 1;
    while (j < total && emBranco(linhas[j] as string)) j++;
    if (j >= total || rotuloDaCarta(linhas[j] as string) !== "I") return false;
    j++;
    while (j < total && emBranco(linhas[j] as string)) j++;
    if (j >= total) return false;
    const depois = linhas[j] as string;
    return rotuloDaCarta(depois) === null && !INICIO_DE_NOTAS.test(depois);
  };

  for (const [i, bruta] of linhas.entries()) {
    const l = bruta as string;
    const numero = i + 1;

    // Dentro do bloco de notas: só uma parte nova (título seguido da carta I) interrompe.
    if (estado === "notas" && !ehInicioDeParte(i)) {
      tratarNota(l);
      continue;
    }

    if (ehInicioDeParte(i)) {
      fecharCarta();
      fecharNota();
      const slug = opcoes.secoes[partes.length];
      if (slug === undefined)
        throw new ErroGutenberg(
          `parte "${l.trim()}" sem slug no registro (o arquivo tem mais partes do que secoes)`,
        );
      parte = { slug, titulo: l.trim(), cartas: [] };
      partes.push(parte);
      estado = "parte";
      continue;
    }

    if (estado !== "antes" && INICIO_DE_NOTAS.test(l)) {
      fecharCarta();
      estado = "notas";
      tratarNota(l);
      continue;
    }

    const rotulo = estado === "parte" || estado === "carta" ? rotuloDaCarta(l) : null;
    if (rotulo !== null) {
      iniciarCarta(rotulo, numero);
      estado = "carta";
      continue;
    }

    if (estado === "carta") {
      if (emBranco(l)) fecharBloco();
      else {
        const limpa = semMarcas(l, etiqueta);
        if (MARCA_DE_HTML.test(limpa))
          throw new ErroGutenberg(
            `marcação HTML que este parser não trata no texto da carta ${parte?.slug}.${cartaAberta()?.rotulo} (linha ${numero} do corpo)`,
          );
        if (limpa.trim() !== "") bloco.push(limpa);
      }
    }
    // Nada mais é feito com a linha: o que sobra fica fora. Em "antes", é o cabeçalho, a página de rosto, a
    // introdução e o índice dos produtores; em "parte", são as linhas em branco entre o título e o cabeçalho
    // da carta I (por definição de `ehInicioDeParte`, qualquer outra coisa entre os dois impede a parte de ser
    // reconhecida, e o arquivo reprova lá embaixo com "nenhuma parte reconhecida").
  }

  fecharCarta();
  fecharNota();
  if (partes.length === 0)
    throw new ErroGutenberg(
      "nenhuma parte reconhecida: esperado um título em caixa alta seguido do cabeçalho da carta I e de texto",
    );
  if (partes.length < opcoes.secoes.length)
    throw new ErroGutenberg(
      `o registro lista ${opcoes.secoes.length} partes e o arquivo tem ${partes.length} (slug sem parte: ${opcoes.secoes[partes.length]})`,
    );

  const correspondencia = opcoes.correspondencia ?? {};
  const usadas = new Set<string>();
  const refsVistas = new Set<string>();
  const secoes: SecaoTei[] = partes.map((p, i) => ({
    slug: p.slug,
    titulo: p.titulo,
    ordem: i + 1,
    paragrafos: p.cartas.map((c): ParagrafoTei => {
      const base = `${p.slug}.${c.rotulo}`;
      // Blocos internos da mesma carta (linha em branco no arquivo): um só parágrafo, unido por espaço.
      const paragrafo = (ref: string): ParagrafoTei => ({
        ref,
        ref_inicio: null,
        ref_fim: null,
        texto: c.blocos.join(" "),
      });
      if (!Object.hasOwn(correspondencia, base)) {
        foraDaTabela.push(base);
        return paragrafo(base);
      }
      const moderna = correspondencia[base] as string;
      if (refsVistas.has(moderna))
        throw new ErroGutenberg(`tabela de correspondência: referência "${moderna}" repetida`);
      refsVistas.add(moderna);
      usadas.add(base);
      return paragrafo(moderna);
    }),
  }));
  // Entrada da tabela que não é carta nenhuma do arquivo é erro: a numeração moderna nunca aparece em silêncio.
  for (const chave of Object.keys(correspondencia))
    if (!usadas.has(chave))
      throw new ErroGutenberg(
        `tabela de correspondência: "${chave}" não é nenhuma carta do arquivo`,
      );

  return { secoes, notas, ausentes, foraDaTabela };
}
