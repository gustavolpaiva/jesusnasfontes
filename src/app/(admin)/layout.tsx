import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { exigirAdmin, sair } from "@/modules/identidade/sessao";

// Toda a área de administração: Admin com o segundo fator verificado nesta sessão. A página e as
// Server Actions conferem de novo (o layout não roda em toda navegação nem em toda ação).
export default async function LayoutAdmin({ children }: { children: ReactNode }) {
  await exigirAdmin();
  const itens = [
    { href: "/trilhas", rotulo: "Trilhas" },
    { href: "/caderno", rotulo: "Caderno" },
    { href: "/conta", rotulo: "Conta" },
    { href: "/admin/convites", rotulo: "Convites" },
  ];
  return (
    <AppShell navegacao={itens} acaoSair={sair}>
      {children}
    </AppShell>
  );
}
