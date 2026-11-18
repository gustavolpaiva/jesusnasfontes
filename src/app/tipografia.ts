import localFont from "next/font/local";

// Fontes hospedadas pelo próprio site: nenhum pedido a terceiro (privacidade) e versalete
// verdadeiro, que a API do Google Fonts remove. Geradas por `pnpm tipografia:gerar`.
// Pesos carregados: 400 e 600. Itálico só em 400; nunca itálico com 600.

// Texto e interface: romano com eixo de peso limitado a 400–600 e itálico 400 (o itálico só é
// pedido pelo navegador quando há texto em itálico).
export const tipografiaCorpo = localFont({
  src: [
    { path: "./tipografia/eb-garamond-400-600.woff2", weight: "400 600", style: "normal" },
    { path: "./tipografia/eb-garamond-italic-400.woff2", weight: "400", style: "italic" },
  ],
  variable: "--font-corpo",
  display: "swap",
  preload: true,
  fallback: ["Georgia", "Times New Roman", "serif"],
  adjustFontFallback: "Times New Roman",
});

// Exibição: Cormorant Garamond 600, nunca abaixo de 24 px.
export const tipografiaExibicao = localFont({
  src: [{ path: "./tipografia/cormorant-garamond-600.woff2", weight: "600", style: "normal" }],
  variable: "--font-exibicao",
  display: "swap",
  preload: true,
  fallback: ["Georgia", "Times New Roman", "serif"],
  adjustFontFallback: "Times New Roman",
});
