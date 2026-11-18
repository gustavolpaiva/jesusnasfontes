import type { Metadata } from "next";
import { cookies } from "next/headers";
import { connection } from "next/server";
import type { CSSProperties, ReactNode } from "react";
import { escalaDoPasso, lerPreferencias } from "@/modules/aparencia/preferencias";
import "./globals.css";
import { tipografiaCorpo, tipografiaExibicao } from "./tipografia";

export const metadata: Metadata = {
  title: "Jesus nas Fontes",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Renderização dinâmica: o nonce da política de conteúdo muda a cada requisição, e o tema e o
  // tamanho do texto vêm dos cookies, lidos no servidor para o HTML já sair certo (sem salto).
  await connection();
  const { tema, passo } = lerPreferencias(await cookies());
  const estilo = { "--escala-texto": String(escalaDoPasso(passo)) } as CSSProperties;
  return (
    <html
      lang="pt-BR"
      className={`${tipografiaCorpo.variable} ${tipografiaExibicao.variable}`}
      data-tema={tema ?? undefined}
      style={estilo}
    >
      <body>{children}</body>
    </html>
  );
}
