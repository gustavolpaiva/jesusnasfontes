import { Check } from "lucide-react";
import Link from "next/link";
import { NOME_DO_NIVEL } from "@/modules/acervo/niveis";
import type { Nivel } from "@/modules/acervo/schemas";

// Filtro por Nível de fonte, na forma de LINKS (a forma de radio chega com a busca). O Nível vai na URL
// (`?nivel=`): não é dado sensível e o endereço fica compartilhável. Só oferece Nível que tem Fonte (D-13).
// A seleção nunca depende só de cor: preenchimento invertido, ícone de marca e `aria-current`.

type Props = {
  oferecidos: readonly { nivel: Nivel; total: number }[];
  selecionado: Nivel | null;
  /** Caminho-base dos links (padrão: a lista do Acervo). */
  base?: string;
};

const item =
  "text-ui inline-flex min-h-11 items-center gap-2 rounded-sm border px-3 py-1 no-underline transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const livre = "border-rule-strong text-ink hover:bg-paper-soft";
const marcado = "border-ink bg-ink text-paper";

function Opcao({
  href,
  rotulo,
  contagem,
  ativo,
}: {
  href: string;
  rotulo: string;
  contagem?: number;
  ativo: boolean;
}) {
  return (
    <li className="flex">
      <Link
        href={href}
        aria-current={ativo ? "true" : undefined}
        data-slot="filtro-nivel-item"
        className={`${item} ${ativo ? marcado : livre}`}
      >
        {ativo ? <Check aria-hidden="true" strokeWidth={2} className="size-3 shrink-0" /> : null}
        <span>
          {rotulo}
          {contagem === undefined ? null : <span className="text-meta"> ({contagem})</span>}
        </span>
      </Link>
    </li>
  );
}

export function FiltroNivel({ oferecidos, selecionado, base = "/acervo" }: Props) {
  return (
    <nav aria-label="Nível de fonte" data-slot="filtro-nivel">
      <ul className="flex flex-wrap gap-2">
        <Opcao href={base} rotulo="Todos" ativo={selecionado === null} />
        {oferecidos.map((o) => (
          <Opcao
            key={o.nivel}
            href={`${base}?nivel=${o.nivel}`}
            rotulo={NOME_DO_NIVEL[o.nivel]}
            contagem={o.total}
            ativo={selecionado === o.nivel}
          />
        ))}
      </ul>
    </nav>
  );
}
