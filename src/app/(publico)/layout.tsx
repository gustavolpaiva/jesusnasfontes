import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";

// Telas públicas: cabeçalho com a marca e o Menu, sem navegação (a navegação é de quem entrou).
export default function LayoutPublico({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
