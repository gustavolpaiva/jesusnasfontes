import { Check } from "lucide-react";
import Link from "next/link";

// Grade de capítulos da Leitura contínua (TRIL-01). Cada casa é um link de 48 px. O estado nunca depende
// só da cor: por fazer = contorno fino; concluída = preenchimento invertido mais a marca de seleção no
// canto; atual = borda grossa em rubrica e `aria-current="step"`; atual e concluída = as duas marcas.
// O nome acessível diz o estado em palavras ("Mateus 5, concluído", "Mateus 5, Estudo atual").

export type CasaDoCapitulo = {
  slug: string;
  capitulo: number;
  concluido: boolean;
  atual: boolean;
};

type Props = {
  /** Nome do livro ("Mateus"), para o nome acessível de cada casa. */
  livro: string;
  casas: CasaDoCapitulo[];
};

function nomeDaCasa(livro: string, c: CasaDoCapitulo): string {
  const partes = [`${livro} ${c.capitulo}`];
  if (c.atual) partes.push("Estudo atual");
  if (c.concluido) partes.push("concluído");
  return partes.join(", ");
}

export function CapituloGrid({ livro, casas }: Props) {
  return (
    <ul
      className="grid"
      // Seis casas por linha em 390 px (342 de coluna), nove na coluna de leitura de 485 px.
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(48px, 1fr))", gap: "8px" }}
    >
      {casas.map((c) => {
        const estado = c.atual
          ? c.concluido
            ? "atual-concluida"
            : "atual"
          : c.concluido
            ? "concluida"
            : "por-fazer";
        return (
          <li key={c.slug} className="flex">
            <Link
              href={`/estudos/${c.slug}`}
              aria-label={nomeDaCasa(livro, c)}
              aria-current={c.atual ? "step" : undefined}
              data-estado={estado}
              className={[
                "text-ui relative flex aspect-square min-h-12 flex-1 items-center justify-center rounded-sm font-semibold no-underline transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                c.concluido
                  ? "bg-ink text-paper hover:bg-ink-muted"
                  : "text-ink hover:bg-paper-soft",
                // Uma só borda por estado: duas classes de cor de borda juntas deixam o CSS escolher.
                c.atual
                  ? "border-2 border-rubric"
                  : c.concluido
                    ? "border border-ink"
                    : "border border-rule-strong",
              ].join(" ")}
            >
              <span aria-hidden="true">{c.capitulo}</span>
              {c.concluido ? (
                <Check
                  aria-hidden="true"
                  strokeWidth={2}
                  className="absolute top-1 right-1 size-3"
                />
              ) : null}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
