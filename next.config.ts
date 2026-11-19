import type { NextConfig } from "next";

const emProducao = process.env.NODE_ENV === "production";

const config: NextConfig = {
  // Desligado na Fase 1: com cacheComponents o Next mantém rotas antigas montadas e oculta
  // efeitos, o que mudaria o comportamento do autosave e do áudio.
  cacheComponents: false,
  // Cada execução de teste usa o seu diretório de build para não colidir com outra.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  poweredByHeader: false,
  // O `next dev` gravaria um AGENTS.md na raiz; esse caminho é proibido no repositório público.
  agentRules: false,
  async headers() {
    const cabecalhos = [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    ];
    if (emProducao) {
      cabecalhos.push({
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      });
    }
    // Páginas de uma pessoa só (posição de leitura): nunca em cache de CDN nem de navegador.
    const semCache = { key: "Cache-Control", value: "no-store" };
    return [
      { source: "/:path*", headers: cabecalhos },
      { source: "/trilhas", headers: [semCache] },
      { source: "/estudos/:slug", headers: [semCache] },
    ];
  },
};

export default config;
