import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Jesus nas Fontes",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Renderização dinâmica: o nonce da política de conteúdo muda a cada requisição.
  await connection();
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
