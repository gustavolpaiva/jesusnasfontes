import { Menu } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

type Props = {
  // Links de navegação para a largura de computador (a partir de 1024 px).
  navegacao?: ReactNode;
  // O Menu inteiro (botão e folha). Sem ele, o cabeçalho mostra só o botão.
  slotMenu?: ReactNode;
};

// Não fixo: mais espaço de leitura e sem conflito com o teclado de tela.
// Altura 69 px: 12 px de respiro, botão de 44 px, 12 px e o filete de 1 px.
export function Cabecalho({ navegacao, slotMenu }: Props) {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-rule px-6 py-3 sm:px-8 md:px-12">
      <Link href="/" className="text-heading min-h-11 content-center text-ink no-underline">
        Jesus nas Fontes
      </Link>
      <div className="flex items-center gap-4">
        {navegacao}
        {slotMenu ?? (
          <button
            type="button"
            aria-label="Abrir menu"
            className="flex size-11 items-center justify-center rounded-sm text-ink transition-colors duration-150 hover:bg-paper-soft"
          >
            <Menu aria-hidden="true" size={22} strokeWidth={1.5} />
          </button>
        )}
      </div>
    </header>
  );
}
