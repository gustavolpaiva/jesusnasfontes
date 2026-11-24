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

export function LinhaFonte({ fonte }: { fonte: LinhaDaLista }) {
  return (
    <li
      data-slot="linha-fonte"
      className="relative flex min-h-16 flex-col justify-center gap-1 border-b border-rule py-3 transition-colors duration-150 last:border-b-0 hover:bg-paper-soft"
    >
      <Link
        href={`/acervo/${fonte.slug}`}
        className="text-ui font-semibold text-ink no-underline [overflow-wrap:anywhere] after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring"
      >
        {fonte.titulo}
      </Link>
      <span className="text-meta text-ink-muted [overflow-wrap:anywhere]">
        {metaDaLinha(fonte)}
      </span>
    </li>
  );
}
