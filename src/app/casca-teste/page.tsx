import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/app-shell";

// Página só de desenvolvimento e de teste: mostra a casca com a navegação de quatro itens (a do
// Admin), que ainda não tem tela real. Em produção não existe (404). Sai quando as telas
// autenticadas dos planos seguintes passarem a cobrir o mesmo caso.
const itens = [
  { href: "/trilhas", rotulo: "Trilhas" },
  { href: "/caderno", rotulo: "Caderno" },
  { href: "/conta", rotulo: "Conta" },
  { href: "/convites", rotulo: "Convites" },
] as const;

export default function CascaDeTeste() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <AppShell navegacao={itens}>
      <div className="coluna-leitura flex flex-col gap-4">
        <h1 className="text-display">Casca de teste</h1>
        <p className="text-leitura">Assim fica o texto de leitura na página atrás da folha.</p>
      </div>
    </AppShell>
  );
}
