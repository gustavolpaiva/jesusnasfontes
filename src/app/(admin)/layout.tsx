import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ITENS_DA_FAIXA } from "@/components/shell/itens-da-faixa";
import { DESTINOS_DE_ADMINISTRACAO } from "@/modules/acervo/navegacao-admin";
import { exigirAdmin, sair } from "@/modules/identidade/sessao";

// Toda a área de administração: Admin com o segundo fator verificado nesta sessão. A página e as
// Server Actions conferem de novo (o layout não roda em toda navegação nem em toda ação).
export default async function LayoutAdmin({ children }: { children: ReactNode }) {
  await exigirAdmin();
  return (
    <AppShell
      navegacao={ITENS_DA_FAIXA}
      itensAdministracao={DESTINOS_DE_ADMINISTRACAO}
      acaoSair={sair}
    >
      {children}
    </AppShell>
  );
}
