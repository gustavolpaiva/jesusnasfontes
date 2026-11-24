import { Check } from "lucide-react";
import Link from "next/link";
import { Algarismos } from "@/components/ui/algarismos";

// Linha de Estudo nas Trilhas Base histórica e Pontos centrais: número, título e a marca de concluído.
// 56 px no mínimo; o título quebra em até três linhas, sem corte; separada da seguinte por um filete,
// sem cartão. A marca de concluído tem forma (o ícone) e texto, nunca só cor.

type Props = {
  numero: number;
  slug: string;
  titulo: string;
  concluido: boolean;
};

export function EstudoRow({ numero, slug, titulo, concluido }: Props) {
  return (
    <li className="border-b border-rule last:border-b-0">
      <Link
        href={`/estudos/${slug}`}
        className="flex min-h-14 items-start gap-4 rounded-sm py-3 no-underline transition-colors duration-150 hover:bg-paper-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="text-label w-8 shrink-0 pt-1 text-ink-muted" aria-hidden="true">
          <Algarismos>{String(numero)}</Algarismos>
        </span>
        <span className="text-ui min-w-0 flex-1 text-balance [overflow-wrap:anywhere]">
          <span className="sr-only">{numero}. </span>
          {titulo}
        </span>
        {concluido ? (
          <span className="flex shrink-0 items-center gap-1 pt-1 text-ink">
            <Check aria-hidden="true" strokeWidth={1.5} className="size-5" />
            <span className="sr-only">, concluído</span>
          </span>
        ) : null}
      </Link>
    </li>
  );
}
