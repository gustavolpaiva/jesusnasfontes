// Parágrafo de uma Fonte, com a referência da obra e âncora `#p-<ref>` (as Citações apontam para cá).
// O texto da Fonte é texto de terceiros: entra SEMPRE como texto React, nunca como marcação. A referência
// é Rótulo, não é link; o leitor de tela ouve "Parágrafo 18.63". O parágrafo-alvo do endereço ganha
// preenchimento e filete pela classe `paragrafo-fonte` (globals.css): é forma, não cor.

type Props = { id: string; ref_: string; texto: string; idioma: "pt" | "en" };

export function ParagrafoFonte({ id, ref_, texto, idioma }: Props) {
  return (
    <p
      id={`p-${ref_}`}
      data-slot="paragrafo-fonte"
      data-paragrafo-id={id}
      lang={idioma}
      className="paragrafo-fonte text-leitura -mx-3 scroll-mt-4 px-3 py-1"
    >
      <span
        lang="pt-BR"
        className="text-label mr-2 inline-block text-ink-muted [font-variant-numeric:tabular-nums]"
      >
        <span className="sr-only">Parágrafo </span>
        {ref_}
      </span>
      {texto}
    </p>
  );
}
