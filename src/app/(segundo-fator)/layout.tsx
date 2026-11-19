import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { exigirPrimeiroFatorDeAdmin, sair } from "@/modules/identidade/sessao";

// Telas do segundo fator: a única área que o Admin alcança só com o primeiro fator. Sem navegação;
// o Menu mostra Aparência e Sair. Quem não é Admin recebe a 404 comum.
export default async function LayoutSegundoFator({ children }: { children: ReactNode }) {
  await exigirPrimeiroFatorDeAdmin();
  return <AppShell acaoSair={sair}>{children}</AppShell>;
}
