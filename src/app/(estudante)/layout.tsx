import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { exigirSessao, sair } from "@/modules/identidade/sessao";

// Tudo sob este grupo exige sessão; a página também confere (o layout não roda em toda navegação).
export default async function LayoutEstudante({ children }: { children: ReactNode }) {
  const { usuario } = await exigirSessao();
  const itens = [
    { href: "/trilhas", rotulo: "Trilhas" },
    { href: "/caderno", rotulo: "Caderno" },
    { href: "/conta", rotulo: "Conta" },
    ...(usuario.papel === "admin" ? [{ href: "/admin/convites", rotulo: "Convites" }] : []),
  ];
  return (
    <AppShell navegacao={itens} acaoSair={sair}>
      {children}
    </AppShell>
  );
}
