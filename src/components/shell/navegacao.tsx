"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type ItemDeNavegacao = { href: string; rotulo: string };

type Props = {
  itens: readonly ItemDeNavegacao[];
  // "rodape": faixa inferior no fluxo da página (até 1023 px). "cabecalho": links no cabeçalho
  // (a partir de 1024 px). Os dois ficam no HTML e o CSS esconde um deles, então só um aparece
  // para o leitor de tela.
  posicao: "rodape" | "cabecalho";
};

export function Navegacao({ itens, posicao }: Props) {
  const caminho = usePathname();
  if (itens.length === 0) return null;
  const noCabecalho = posicao === "cabecalho";

  return (
    <nav
      aria-label="Seções"
      className={
        noCabecalho
          ? "hidden lg:flex lg:items-stretch lg:gap-2"
          : "mt-auto border-t border-rule pb-[env(safe-area-inset-bottom)] lg:hidden"
      }
    >
      <ul
        className={noCabecalho ? "flex items-stretch gap-2" : "grid"}
        style={
          noCabecalho
            ? undefined
            : { gridTemplateColumns: `repeat(${itens.length}, minmax(0, 1fr))` }
        }
      >
        {itens.map((item) => {
          const ativo = caminho === item.href || caminho.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className="flex min-w-0">
              <Link
                href={item.href}
                aria-current={ativo ? "page" : undefined}
                className={[
                  "text-label flex min-w-0 flex-1 items-center justify-center px-1 text-center [overflow-wrap:anywhere] hyphens-auto no-underline transition-colors duration-150",
                  noCabecalho ? "min-h-11 border-b-2 px-4" : "-mt-px min-h-[60px] border-t-2",
                  ativo
                    ? "border-rubric text-rubric"
                    : "border-transparent text-ink-muted hover:bg-paper-soft hover:text-ink",
                ].join(" ")}
              >
                {item.rotulo}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
