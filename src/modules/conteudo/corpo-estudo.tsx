import Markdown, { type Components } from "react-markdown";
import remarkDirective from "remark-directive";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { Afirmacao, ChipFonte, ResumoFonteEmPreparacao } from "./afirmacao";
import { Divergencia } from "./divergencia";
import type { EstudoCompleto } from "./estudo";
import { GrauDeCerteza } from "./grau-de-certeza";
import { remarkAfirmacao } from "./remark-afirmacao";

// Corpo do Estudo (o Markdown do conteúdo), em Corpo de leitura. A assinatura é
// `CorpoEstudo({ estudo, volta? })`: o 01-13 passa a volta atual da Leitura contínua (padrão 1).
//
// Sem HTML cru: o `react-markdown` ignora HTML embutido, e nenhum plugin que o habilite é usado.
// Só os elementos abaixo são aceitos; os outros perdem a marcação e ficam como texto. O texto do
// Estudo não tem link nem imagem (UI-SPEC: alvos de toque, sem rastreio), por isso `a` mostra só o
// texto e `img` não existe. `span` e `sup` existem só como saída do `remarkAfirmacao` (a Afirmação, o
// chip e o ordinal); a diretiva nunca vira marcação livre.

// `h1` precisa estar na lista para chegar ao conversor abaixo, que o rebaixa a `h2`; fora dela o
// título seria desembrulhado e viraria texto solto.
const ELEMENTOS = [
  "p",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "blockquote",
  "br",
  "a",
  "span",
  "sup",
];

const componentes: Components = {
  // Título de seção em Rótulo (versalete); `h1` do Markdown não existe: a tela tem um só `h1`.
  h1: ({ children }) => <h2 className="text-label mt-2 text-ink-muted">{children}</h2>,
  h2: ({ children }) => <h2 className="text-label mt-2 text-ink-muted">{children}</h2>,
  h3: ({ children }) => <h3 className="text-label text-ink-muted">{children}</h3>,
  p: ({ children }) => <p className="text-leitura">{children}</p>,
  ul: ({ children }) => (
    <ul className="text-leitura flex list-disc flex-col gap-2 pl-6">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="text-leitura flex list-decimal flex-col gap-2 pl-6">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="text-leitura border-l-2 border-ink pl-4 italic">{children}</blockquote>
  ),
  a: ({ children }) => <>{children}</>,
  // A frase marcada, o chip que vem depois do bloco e o ordinal em `sup`: tudo gerado pelo plugin.
  span: (props) => {
    const p = props as Record<string, unknown>;
    if (p["data-chip-fonte"] !== undefined) {
      const ordinal = Number(p["data-ordinal"]);
      return (
        <ChipFonte variante="preparacao" ordinal={Number.isInteger(ordinal) ? ordinal : null} />
      );
    }
    const id = p["data-afirmacao-id"];
    if (typeof id === "string" && id !== "") return <Afirmacao id={id}>{props.children}</Afirmacao>;
    return <>{props.children}</>;
  },
  sup: ({ children }) => (
    <sup className="select-none text-ink-muted" style={{ fontSize: "0.7em" }}>
      {children}
    </sup>
  ),
};

type Secao = { titulo: string | null; md: string };

// Divide o corpo nas seções `## Título` (o título fica no texto da seção). O que vier antes do
// primeiro título é uma seção sem título.
function dividirEmSecoes(md: string): Secao[] {
  const secoes: Secao[] = [];
  let atual: string[] = [];
  let titulo: string | null = null;
  const fechar = () => {
    const texto = atual.join("\n").trim();
    if (texto !== "") secoes.push({ titulo, md: texto });
  };
  for (const linha of md.split("\n")) {
    const t = /^##\s+(.+?)\s*$/.exec(linha);
    if (t) {
      fechar();
      atual = [linha];
      titulo = t[1] ?? null;
    } else atual.push(linha);
  }
  fechar();
  return secoes;
}

// A capitular só vale quando o primeiro caractere do primeiro parágrafo é uma letra (parágrafo que
// começa por número, aspas ou « » não leva).
function temCapitular(md: string): boolean {
  for (const linha of md.split("\n")) {
    const l = linha.trim();
    if (l === "" || l.startsWith("#")) continue;
    if (/^([-*+]|\d+[.)])\s/.test(l) || l.startsWith(">")) return false;
    return /^\p{L}/u.test(l.replace(/^:afirmacao\[/, ""));
  }
  return false;
}

// Capitular: três linhas de altura, Cormorant Garamond 600 em rubrica, derivada do Corpo de leitura
// (não é um quinto tamanho). Com `::first-letter`, o leitor de tela lê a palavra inteira. Onde o
// navegador tem `initial-letter` (Chromium e Safari), é ele quem acerta as três linhas pela linha de
// base; onde não tem, vale a letra flutuante do contrato (3,4 vezes o Corpo, altura de linha 0,82).
// O parágrafo vira `flow-root` para conter a letra flutuante: com menos de três linhas de texto, a
// capitular não pode vazar para o bloco seguinte. As classes ficam escritas por inteiro: o Tailwind só
// gera o que acha escrito no código, nunca o que se monta por concatenação.
const CAPITULAR =
  "[&>[data-secao]:first-of-type>p:first-of-type]:flow-root " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:first-letter:font-display " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:first-letter:font-semibold " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:first-letter:text-rubric " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:first-letter:pr-2 " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:supports-[initial-letter:3]:first-letter:[initial-letter:3] " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:not-supports-[initial-letter:3]:first-letter:float-left " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:not-supports-[initial-letter:3]:first-letter:[font-size:calc(var(--text-leitura)*3.4)] " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:not-supports-[initial-letter:3]:first-letter:leading-[0.82] " +
  "[&>[data-secao]:first-of-type>p:first-of-type]:not-supports-[initial-letter:3]:first-letter:pt-1";

const TRILHA_DAS_PERGUNTAS = "leitura-continua";

export function CorpoEstudo({ estudo, volta = 1 }: { estudo: EstudoCompleto; volta?: number }) {
  const secoes = dividirEmSecoes(estudo.corpoMd);
  // O resumo recolhido vem antes da primeira seção que tem Afirmação, só uma vez por Estudo.
  const primeiraComAfirmacao = secoes.findIndex((s) => s.md.includes(":afirmacao["));
  // Na Leitura contínua o conjunto de perguntas gira a cada volta: (volta - 1) mod 3.
  const conjunto = (((Math.max(1, volta) - 1) % 3) + 3) % 3;
  const perguntas =
    estudo.trilha.id === TRILHA_DAS_PERGUNTAS && estudo.perguntas.length === 3
      ? (estudo.perguntas[conjunto] ?? [])
      : [];

  // O Grau de certeza só aparece com o valor classificado E revisado pelo dono: nunca um valor não
  // revisado como se fosse a classificação do centro. Vem antes de "Para hoje" (ou no fim, sem ela).
  const grau = estudo.grauDeCerteza;
  const mostrarGrau = grau !== null && grau.valor !== null && grau.revisado;
  const antesDeParaHoje = secoes.findIndex((s) => s.titulo === "Para hoje");
  const blocoDoGrau =
    mostrarGrau && grau?.valor ? <GrauDeCerteza valor={grau.valor} texto={grau.texto} /> : null;

  return (
    <div
      className={cn("flex flex-col gap-4", secoes[0] && temCapitular(secoes[0].md) && CAPITULAR)}
      data-corpo-estudo
    >
      {secoes.map((secao, indice) => (
        <div key={secao.titulo ?? "abertura"} className="flex flex-col gap-4" data-secao>
          {indice === primeiraComAfirmacao ? <ResumoFonteEmPreparacao /> : null}
          {indice === antesDeParaHoje ? blocoDoGrau : null}
          <Markdown
            remarkPlugins={[remarkGfm, remarkDirective, remarkAfirmacao]}
            allowedElements={ELEMENTOS}
            unwrapDisallowed
            components={componentes}
          >
            {secao.md}
          </Markdown>
        </div>
      ))}
      {antesDeParaHoje < 0 ? blocoDoGrau : null}
      {perguntas.length > 0 ? (
        <section aria-labelledby="perguntas-titulo" className="flex flex-col gap-4" data-secao>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
            <h2 id="perguntas-titulo" className="text-label text-ink-muted">
              Três perguntas para responder
            </h2>
            {volta > 1 ? (
              <span className="text-meta text-ink-muted" data-volta>
                volta {volta}
              </span>
            ) : null}
          </div>
          <ol className="text-leitura flex list-decimal flex-col gap-2 pl-6">
            {perguntas.map((pergunta) => (
              <li key={pergunta}>{pergunta}</li>
            ))}
          </ol>
        </section>
      ) : null}
      <Divergencia divergencias={estudo.divergencias} />
    </div>
  );
}
