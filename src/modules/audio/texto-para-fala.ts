import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { EstudoCompleto } from "@/modules/conteudo/estudo";
import { buscarLivro, referenciaParaFala } from "@/modules/referencias";

// O que a voz lê (AUD-01, AUD-04). Duas funções puras que viram o conteúdo em texto falado:
//
//   estudoParaFala   o título, a indicação da leitura bíblica e as seções NA ORDEM DA TELA, com o
//                    título de cada seção; as referências bíblicas por extenso falado.
//   passagemParaFala o texto bíblico corrido.
//
// O que NÃO é lido (decisão pelo contrato visual, tela 7, "Afirmação e Fonte em preparação"): o chip
// "Fonte em preparação" e o ordinal da Afirmação, o resumo recolhido "O que é “Fonte em preparação”?",
// o eyebrow, a meta de duração, o rótulo "volta N", os botões e a Sessão. São rótulos de interface, não
// o conteúdo do Estudo. Números de versículo, os sinais « » e as marcas de nota do texto bíblico
// também ficam de fora. Ninguém aqui lê um segredo ou uma Anotação: só conteúdo público do centro.

type No = {
  type: string;
  name?: string;
  value?: string;
  children?: No[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const SINAIS_DE_PARAGRAFO = /[.!?…:;]["”’»)]*$/u;

/** Termina o bloco com pontuação, para a voz fazer a pausa e para a divisão em frases. */
function fechar(texto: string): string {
  return SINAIS_DE_PARAGRAFO.test(texto) ? texto : `${texto}.`;
}

// Palavras que também são abreviações de livros e, sem versículo, aparecem em frase comum
// ("Os 3 pilares", "Em 2026"). Só valem como referência quando trazem capítulo e versículo.
const AMBIGUAS = new Set(["os", "em", "is", "am", "ex", "as"]);
const LIVRO_ANTES_DO_NUMERO = "(?:[1-3]\\s?)?\\p{Lu}[\\p{L}.]{0,14}";
const REFERENCIA_NO_TEXTO = new RegExp(
  `(?<![\\p{L}\\d])(${LIVRO_ANTES_DO_NUMERO})\\s+(\\d{1,3}(?::\\d{1,3})?(?:(?:\\s?[-–]\\s?|\\s+a\\s+)\\d{1,3}(?::\\d{1,3})?)?)(?![\\d:])`,
  "gu",
);

/** "Mt 3:13-17" vira "Mateus, capítulo 3, versículos 13 a 17"; o que não for referência fica igual. */
export function referenciasPorExtenso(texto: string): string {
  return texto.replace(REFERENCIA_NO_TEXTO, (achado, livro: string, numeros: string) => {
    const nome = livro.trim();
    if (!buscarLivro(nome)) return achado;
    if (AMBIGUAS.has(nome.toLowerCase().replace(/\./g, "")) && !numeros.includes(":"))
      return achado;
    try {
      return referenciaParaFala(`${nome} ${numeros}`);
    } catch {
      return achado;
    }
  });
}

function limparTexto(texto: string): string {
  return referenciasPorExtenso(texto.replace(/[«»]/gu, "")).replace(/\s+/gu, " ").trim();
}

// ---- Markdown do Estudo -------------------------------------------------------------------------

function textoDoNo(no: No, fonte: string): string {
  switch (no.type) {
    case "text":
    case "inlineCode":
      return no.value ?? "";
    case "break":
      return " ";
    case "textDirective": {
      if (no.name === "afirmacao")
        return (no.children ?? []).map((f) => textoDoNo(f, fonte)).join("");
      // ":13" de "Mt 3:13" chega como diretiva: volta ao texto exato do arquivo.
      const de = no.position?.start.offset;
      const ate = no.position?.end.offset;
      return de !== undefined && ate !== undefined ? fonte.slice(de, ate) : `:${no.name ?? ""}`;
    }
    case "html":
      return "";
    default:
      return (no.children ?? []).map((f) => textoDoNo(f, fonte)).join("");
  }
}

function blocosDoMarkdown(md: string): string[] {
  const arvore = unified().use(remarkParse).use(remarkDirective).parse(md) as unknown as No;
  const blocos: string[] = [];
  const andar = (no: No) => {
    switch (no.type) {
      case "heading":
      case "paragraph": {
        const texto = limparTexto(textoDoNo(no, md));
        if (texto !== "") blocos.push(fechar(texto));
        return;
      }
      case "code":
      case "html":
      case "thematicBreak":
      case "definition":
        return;
      default:
        for (const filho of no.children ?? []) andar(filho);
    }
  };
  andar(arvore);
  return blocos;
}

// ---- O Estudo -----------------------------------------------------------------------------------

export type EstudoFalavel = Pick<
  EstudoCompleto,
  "titulo" | "trilha" | "corpoMd" | "grauDeCerteza" | "passagens" | "divergencias" | "perguntas"
>;

const NOME_DO_GRAU = {
  consenso: "Consenso",
  "posicao-majoritaria": "Posição majoritária",
  disputada: "Disputada",
} as const;

const NOME_DA_TRADICAO = {
  catolica: "Tradição católica",
  ortodoxa: "Tradição ortodoxa",
  protestante: "Tradição protestante",
} as const;

const INTRODUCAO_DA_DIVERGENCIA =
  "Cristãos de tradições diferentes leem este ponto de formas diferentes. Mostramos cada leitura, sem escolher uma.";

const TRILHA_DAS_PERGUNTAS = "leitura-continua";

/** Divide o corpo nas seções `## Título`, como a tela (`CorpoEstudo`): o título abre a seção. */
function secoesDoCorpo(md: string): { titulo: string | null; md: string }[] {
  const secoes: { titulo: string | null; md: string }[] = [];
  let atual: string[] = [];
  let titulo: string | null = null;
  const encerrar = () => {
    const texto = atual.join("\n").trim();
    if (texto !== "") secoes.push({ titulo, md: texto });
  };
  for (const linha of md.split("\n")) {
    const t = /^##\s+(.+?)\s*$/.exec(linha);
    if (t) {
      encerrar();
      atual = [linha];
      titulo = t[1] ?? null;
    } else atual.push(linha);
  }
  encerrar();
  return secoes;
}

/**
 * O texto que a voz lê do Estudo, em blocos separados por linha em branco. A ordem é a da tela:
 * título, leitura bíblica, seções (o Grau de certeza onde a tela o põe, só quando revisado), as
 * perguntas da volta e a Divergência entre tradições.
 */
export function estudoParaFala(estudo: EstudoFalavel, opcoes: { volta?: number } = {}): string {
  const blocos: string[] = [fechar(limparTexto(estudo.titulo))];

  const leitura = estudo.passagens
    .map((p) => {
      try {
        return referenciaParaFala(p.referenciaTexto);
      } catch {
        return "";
      }
    })
    .filter((f) => f !== "");
  if (leitura.length > 0) blocos.push(fechar(`Leitura bíblica: ${leitura.join(". ")}`));

  const grau = estudo.grauDeCerteza;
  const grauBlocos: string[] =
    grau !== null && grau.valor !== null && grau.revisado
      ? [
          fechar(`Grau de certeza: ${NOME_DO_GRAU[grau.valor]}`),
          ...(grau.texto ? [fechar(limparTexto(grau.texto))] : []),
        ]
      : [];

  const secoes = secoesDoCorpo(estudo.corpoMd);
  const antesDeParaHoje = secoes.findIndex((s) => s.titulo === "Para hoje");
  secoes.forEach((secao, indice) => {
    if (indice === antesDeParaHoje) blocos.push(...grauBlocos);
    blocos.push(...blocosDoMarkdown(secao.md));
  });
  if (antesDeParaHoje < 0) blocos.push(...grauBlocos);

  if (estudo.trilha.id === TRILHA_DAS_PERGUNTAS && estudo.perguntas.length === 3) {
    const conjunto = (((Math.max(1, opcoes.volta ?? 1) - 1) % 3) + 3) % 3;
    const perguntas = estudo.perguntas[conjunto] ?? [];
    if (perguntas.length > 0) {
      blocos.push("Três perguntas para responder.");
      for (const p of perguntas) blocos.push(fechar(limparTexto(p)));
    }
  }

  if (estudo.divergencias.length > 0) {
    blocos.push("Divergência entre tradições.", INTRODUCAO_DA_DIVERGENCIA);
    for (const d of estudo.divergencias) {
      blocos.push(fechar(limparTexto(d.tema)));
      for (const leitura of d.leituras) {
        blocos.push(`${NOME_DA_TRADICAO[leitura.tradicao]}.`, fechar(limparTexto(leitura.resumo)));
      }
    }
  }
  return blocos.join("\n\n");
}

// ---- O texto bíblico ----------------------------------------------------------------------------

export type TrechoBiblicoFalavel = {
  /** A referência já falada ("Mateus, capítulo 3, versículos 13 a 17"), pronta do servidor. */
  referenciaFalada: string;
  capitulos: {
    /** "Mateus 4": só quando a Passagem passa de um capítulo. */
    subtitulo: string | null;
    versiculos: { conteudo: string }[];
  }[];
};

// Marcas de nota que o texto pode trazer no meio do verso: [a], [1], *, †, ‡, § e as letras e
// algarismos sobrescritos. As notas em si ficam no banco, fora do `conteudo`.
const MARCAS_DE_NOTA = /\[\s*(?:\d{1,3}|[a-zA-Z*†‡§])\s*\]|[*†‡§¶]|[¹²³⁰-⁹ⁱ-ₜ]/gu;

/** O texto de um verso, sem « », sem marca de nota e sem número de versículo. */
export function versiculoParaFala(conteudo: string): string {
  return conteudo
    .replace(/[«»]/gu, "")
    .replace(MARCAS_DE_NOTA, "")
    .replace(/\s+([,;:.!?])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

/** O texto bíblico corrido: a referência falada, o subtítulo de cada capítulo e os versos, sem números. */
export function passagemParaFala(trechos: readonly TrechoBiblicoFalavel[]): string {
  const blocos: string[] = [];
  for (const trecho of trechos) {
    if (trecho.referenciaFalada !== "") blocos.push(fechar(trecho.referenciaFalada));
    for (const capitulo of trecho.capitulos) {
      if (capitulo.subtitulo) blocos.push(fechar(limparTexto(capitulo.subtitulo)));
      const corrido = capitulo.versiculos
        .map((v) => versiculoParaFala(v.conteudo))
        .filter((v) => v !== "")
        .join(" ");
      if (corrido !== "") blocos.push(corrido);
    }
  }
  return blocos.join("\n\n");
}
