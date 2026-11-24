import Link from "next/link";
import { SeloNivel } from "@/components/acervo/selo-nivel";
import type { ModoDoAcerto, ResultadoDeBusca } from "@/modules/acervo/busca";
import { dividirTrecho } from "@/modules/caderno/trecho";

// Um resultado da busca do Acervo (tela 3), sem cartão, com filete embaixo. O trecho é TEXTO de uma Fonte ou de um
// resumo: as palavras achadas viram `<mark>` (peso 600 e sublinhado de 2 px na rubrica, sem fundo, então o realce
// não depende de cor) e todo o resto entra como texto React, nunca como HTML do banco. O acerto em português vem do
// resumo auxiliar e leva o rótulo (D-18: sem ele o resumo passaria por revisado); o acerto em inglês vem do texto
// e leva `lang="en"`, para o leitor de tela trocar de voz.

const MODO: Record<ModoDoAcerto, string> = {
  "resumo-pt": "Encontrado no resumo em português",
  "texto-en": "Encontrado no texto em inglês",
  ficha: "Encontrado na ficha",
};

/** Para onde o título leva: a seção (com o parágrafo achado, quando é o texto), a Fonte ou a ficha. */
export function destinoDoResultado(r: ResultadoDeBusca): string {
  if (r.tipo === "ficha" || r.secaoSlug === null) return `/acervo/${r.fonteSlug}`;
  const base = `/acervo/${r.fonteSlug}/${r.secaoSlug}`;
  return r.ref ? `${base}#p-${r.ref}` : base;
}

export function ResultadoBusca({ resultado: r }: { resultado: ResultadoDeBusca }) {
  const partes = dividirTrecho(r.trecho);
  const titulo = r.tipo === "ficha" ? r.fonteTitulo : (r.secaoTitulo ?? r.fonteTitulo);
  return (
    <li
      data-slot="resultado-busca"
      data-modo={r.modo}
      className="flex flex-col gap-2 border-b border-rule py-4 last:border-b-0"
    >
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SeloNivel nivel={r.nivel} />
        <span className="text-meta text-ink-muted">{MODO[r.modo]}</span>
      </p>
      <h2 className="text-heading text-balance [overflow-wrap:anywhere]">
        <Link
          href={destinoDoResultado(r)}
          className="flex min-h-11 items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {titulo}
        </Link>
      </h2>
      {r.tipo === "secao" ? (
        <p className="text-meta text-ink-muted [overflow-wrap:anywhere]">
          {r.fonteTitulo} · {r.secaoTitulo}
        </p>
      ) : null}
      {r.modo === "resumo-pt" ? (
        <p className="text-meta text-ink-muted">Resumo auxiliar, escrito por IA</p>
      ) : null}
      <p
        lang={r.idioma === "en" ? "en" : "pt-BR"}
        className="text-leitura [overflow-wrap:anywhere]"
      >
        {partes.map((p, i) =>
          p.achado ? (
            <mark
              // biome-ignore lint/suspicious/noArrayIndexKey: trechos fixos nesta renderização
              key={i}
              className="bg-transparent font-semibold text-inherit underline decoration-rubric decoration-2 underline-offset-4"
            >
              {p.texto}
            </mark>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: trechos fixos nesta renderização
            <span key={i}>{p.texto}</span>
          ),
        )}
      </p>
    </li>
  );
}
