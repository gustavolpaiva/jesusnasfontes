import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { exigirSessao, sair } from "@/modules/identidade/sessao";

// Telas do consentimento: a única área que o Estudante alcança antes de consentir. Exige a sessão, mas
// não o consentimento (`exigirConsentimento: false`). Sem navegação: o cabeçalho mostra só a marca e o
// Menu, com Aparência e Sair.
export default async function LayoutConsentimento({ children }: { children: ReactNode }) {
  await exigirSessao({ exigirConsentimento: false });
  return <AppShell acaoSair={sair}>{children}</AppShell>;
}
