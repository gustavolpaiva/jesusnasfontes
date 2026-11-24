import { Children, Fragment, type ReactNode } from "react";

// Algarismos dentro do Rótulo (`text-label`, versalete verdadeiro). Na EB Garamond os algarismos de
// versalete se parecem com letras ("p. 101" sai "p. ioi"), e um número de página, de seção ou de data
// que se lê como letra é erro de conteúdo. Todo texto que pode trazer algarismo e vai num Rótulo passa
// por aqui: cada sequência de dígitos vai num `<span class="algarismos">`, que desliga o versalete e
// usa algarismos de altura de maiúscula (globals.css). O resto do texto não muda. O teste
// `algarismos-em-rotulo.spec.ts` confere a regra em toda tela da fase.

const SEQUENCIA_DE_DIGITOS = /(\d+)/;

function partir(texto: string): ReactNode[] {
  const nos: ReactNode[] = [];
  texto.split(SEQUENCIA_DE_DIGITOS).forEach((parte, i) => {
    if (parte === "") return;
    // Partes de índice ímpar são as sequências de dígitos (o `split` com grupo as devolve entre os textos).
    nos.push(
      i % 2 === 1 ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: partes fixas de um texto, na ordem
        <span key={i} className="algarismos">
          {parte}
        </span>
      ) : (
        // biome-ignore lint/suspicious/noArrayIndexKey: partes fixas de um texto, na ordem
        <Fragment key={i}>{parte}</Fragment>
      ),
    );
  });
  return nos;
}

/** O texto com cada sequência de dígitos fora do versalete. Texto sem dígito volta como veio. */
export function comAlgarismos(texto: string): ReactNode {
  return SEQUENCIA_DE_DIGITOS.test(texto) ? partir(texto) : texto;
}

/** Atravessa `children`: textos e números são tratados; elementos (ícones, `<time>`, `<sup>`) ficam. */
export function Algarismos({ children }: { children?: ReactNode }): ReactNode {
  return Children.map(children, (filho) =>
    typeof filho === "string" || typeof filho === "number" ? comAlgarismos(String(filho)) : filho,
  );
}
