import Link from "next/link";
import type { LinhaDaLista } from "@/modules/acervo/consultas-lista";

// Linha da lista do Acervo: sem cartão, filete embaixo, 64 px no mínimo. O título é o link e cobre a linha
// inteira por um pseudo-elemento (o nome acessível é só o título); a meta vai em itálico abaixo. O título
// quebra em quantas linhas precisar, sem corte.

const IDIOMA: Record<LinhaDaLista["idioma"], string> = { pt: "português", en: "inglês" };

/** "{autor} · {época} · texto em {idioma}" ou, para ficha, "{autor}, {ano} · ficha". */
export function metaDaLinha(l: LinhaDaLista): string {
  if (l.tipo === "ficha") {
    const autor = [l.autor, l.ano === null ? null : String(l.ano)].filter(Boolean).join(", ");
    return [autor, "ficha"].filter(Boolean).join(" · ");
  }
  return [l.autor, l.epoca, `texto em ${IDIOMA[l.idioma]}`].filter(Boolean).join(" · ");
}

function LinhaDeLista({
  slot,
  href,
  titulo,
  meta,
}: {
  slot: string;
  href: string;
  titulo: string;
  meta: string;
}) {
  return (
    <li
      data-slot={slot}
      className="relative flex min-h-16 flex-col justify-center border-b border-rule py-2 transition-colors duration-150 last:border-b-0 hover:bg-paper-soft has-[a:focus-visible]:bg-paper-soft"
    >
      {/* O link tem 44 px de altura e o contorno de foco; o pseudo-elemento estende o clique à linha toda. */}
      <Link
        href={href}
        className="text-ui flex min-h-11 items-center rounded-sm font-semibold text-ink no-underline [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {titulo}
      </Link>
      <span className="text-meta -mt-1 pb-1 text-ink-muted [overflow-wrap:anywhere]">{meta}</span>
    </li>
  );
}

export function LinhaFonte({ fonte }: { fonte: LinhaDaLista }) {
  return (
    <LinhaDeLista
      slot="linha-fonte"
      href={`/acervo/${fonte.slug}`}
      titulo={fonte.titulo}
      meta={metaDaLinha(fonte)}
    />
  );
}

/** "1 parágrafo" ou "{n} parágrafos". */
export function contagemDeParagrafos(n: number): string {
  return n === 1 ? "1 parágrafo" : `${n} parágrafos`;
}

/** Linha do sumário da Fonte: o mesmo molde da lista, com o número de parágrafos na meta. */
export function LinhaSecao({
  slugDaFonte,
  secao,
}: {
  slugDaFonte: string;
  secao: { slug: string; titulo: string; numeroDeParagrafos: number };
}) {
  return (
    <LinhaDeLista
      slot="linha-secao"
      href={`/acervo/${slugDaFonte}/${secao.slug}`}
      titulo={secao.titulo}
      meta={contagemDeParagrafos(secao.numeroDeParagrafos)}
    />
  );
}
