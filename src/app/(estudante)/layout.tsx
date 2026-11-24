import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ITENS_DA_FAIXA } from "@/components/shell/itens-da-faixa";
import { DESTINOS_DE_ADMINISTRACAO } from "@/modules/acervo/navegacao-admin";
import { exigirSessao, sair } from "@/modules/identidade/sessao";

// Tudo sob este grupo exige sessão; a página também confere (o layout não roda em toda navegação).
// Os destinos de administração só existem na casca de quem é Admin (e as rotas conferem de novo).
export default async function LayoutEstudante({ children }: { children: ReactNode }) {
  const { usuario } = await exigirSessao();
  return (
    <AppShell
      navegacao={ITENS_DA_FAIXA}
      itensAdministracao={usuario.papel === "admin" ? DESTINOS_DE_ADMINISTRACAO : undefined}
      acaoSair={sair}
    >
      {children}
    </AppShell>
  );
}
