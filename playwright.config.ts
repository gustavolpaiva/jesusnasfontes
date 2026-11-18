import { defineConfig } from "@playwright/test";

const porta = process.env.PORTA_E2E ?? "3100";

type Esquema = "light" | "dark";

function varredura(nome: string, largura: number, altura: number, colorScheme: Esquema) {
  return {
    name: nome,
    grep: /@varredura/,
    use: {
      browserName: "chromium" as const,
      viewport: { width: largura, height: altura },
      colorScheme,
    },
  };
}

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: `test-results/e2e-${porta}`,
  reporter: "list",
  fullyParallel: true,
  forbidOnly: true,
  use: { baseURL: `http://localhost:${porta}` },
  webServer: {
    command: `pnpm dev --port ${porta}`,
    url: `http://localhost:${porta}`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    timeout: 120_000,
  },
  projects: [
    {
      name: "celular",
      grepInvert: /@varredura/,
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: "light",
      },
    },
    {
      name: "computador",
      grepInvert: /@varredura/,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 800 },
        colorScheme: "light",
      },
    },
    varredura("varredura-320-claro", 320, 640, "light"),
    varredura("varredura-320-escuro", 320, 640, "dark"),
    varredura("varredura-360-claro", 360, 800, "light"),
    varredura("varredura-390-escuro", 390, 844, "dark"),
    varredura("varredura-1280-claro", 1280, 800, "light"),
    varredura("varredura-1280-escuro", 1280, 800, "dark"),
  ],
});
