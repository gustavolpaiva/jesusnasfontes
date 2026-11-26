import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
          // Alguns testes de unidade sobem um processo de verdade (`tsx scripts/...`, "o comando"): com a máquina em carga de 20 (outros
          // projetos do dono, medido em 26/11/2026) a partida passa de 5 s e 2 dos 1236 estouraram o padrão; quieta, a suíte inteira roda em
          // cerca de 15 s. O mesmo prazo do projeto de integração.
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/support/banco-local.ts"],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
