import Link from "next/link";
import type { ReactNode } from "react";
import { OfflineBanner } from "@/components/estado/offline-banner";
import { Cabecalho } from "./cabecalho";
import { LinkDeSalto } from "./link-de-salto";
import { MenuSheet } from "./menu-sheet";
import { type ItemDeNavegacao, Navegacao } from "./navegacao";

type Props = {
  children: ReactNode;
  // Itens da navegação (só para quem está autenticado). Sem itens, não há navegação.
  navegacao?: readonly ItemDeNavegacao[];
  // Ação de sair, entregue pelo plano de autenticação; sem ela o Menu não mostra "Sair".
  acaoSair?: () => Promise<void>;
};

const margens = "px-6 sm:px-8 md:px-12";

export function AppShell({ children, navegacao = [], acaoSair }: Props) {
  return (
    <div className="flex min-h-dvh flex-col">
      <LinkDeSalto />
      <Cabecalho
        slotMenu={<MenuSheet itens={navegacao} acaoSair={acaoSair} />}
        navegacao={
          navegacao.length > 0 ? <Navegacao itens={navegacao} posicao="cabecalho" /> : null
        }
      />
      <main id="conteudo" tabIndex={-1} className={`flex-1 py-8 outline-none md:py-12 ${margens}`}>
        <OfflineBanner />
        {children}
      </main>
      {navegacao.length > 0 ? <Navegacao itens={navegacao} posicao="rodape" /> : null}
      <footer
        className={`text-label flex flex-wrap items-center justify-center gap-x-2 border-t border-rule py-3 text-ink-muted ${margens}`}
      >
        <Link
          href="/privacidade"
          className="inline-flex min-h-11 items-center px-2 text-ink-muted underline"
        >
          Aviso de privacidade
        </Link>
        <span aria-hidden="true">·</span>
        <Link
          href="/creditos"
          className="inline-flex min-h-11 items-center px-2 text-ink-muted underline"
        >
          Créditos
        </Link>
      </footer>
    </div>
  );
}
