import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { EstudoCompleto } from "./estudo";

// Corpo do Estudo (o Markdown do conteúdo), em Corpo de leitura. Contrato de montagem: o 01-12
// estende este componente (Afirmação, chip, capitular, Grau de certeza, Divergência) sem mudar a
// assinatura `CorpoEstudo({ estudo })`.
//
// Sem HTML cru: o `react-markdown` ignora HTML embutido, e nenhum plugin que o habilite é usado.
// Só os elementos abaixo são aceitos; os outros perdem a marcação e ficam como texto. O texto do
// Estudo não tem link nem imagem (UI-SPEC: alvos de toque, sem rastreio), por isso `a` mostra só o
// texto e `img` não existe.

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
};

export function CorpoEstudo({ estudo }: { estudo: EstudoCompleto }) {
  return (
    <div className="flex flex-col gap-4" data-corpo-estudo>
      <Markdown
        remarkPlugins={[remarkGfm]}
        allowedElements={ELEMENTOS}
        unwrapDisallowed
        components={componentes}
      >
        {estudo.corpoMd}
      </Markdown>
    </div>
  );
}
