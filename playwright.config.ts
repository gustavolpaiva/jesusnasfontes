import { defineConfig } from "@playwright/test";

const porta = process.env.PORTA_E2E ?? "3100";
// Fumaça contra uma pré-visualização implantada: com PREVIEW_URL a configuração é só do projeto
// `preview` (sem servidor local, sem aquecimento, sem banco de execução). Sem PREVIEW_URL o projeto
// `preview` não existe, e os testes de `tests/e2e/preview` ficam fora dos demais.
const urlPreview = process.env.PREVIEW_URL;
// Quando a proteção de implantação está ligada, o segredo de automação libera as requisições.
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
// Com JNF_LOG_SERVIDOR, a saída do servidor (stdout e stderr) vai para esse arquivo.
const logServidor = process.env.JNF_LOG_SERVIDOR;
const comandoServidor = logServidor
  ? `exec pnpm dev --port ${porta} > "${logServidor}" 2>&1`
  : `pnpm dev --port ${porta}`;

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

const configPreview = defineConfig({
  testDir: "tests/e2e/preview",
  outputDir: "test-results/e2e-preview",
  reporter: "list",
  // Um processo: as medições de tempo não competem entre si.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  use: {
    baseURL: urlPreview,
    ...(bypass
      ? {
          extraHTTPHeaders: {
            "x-vercel-protection-bypass": bypass,
            "x-vercel-set-bypass-cookie": "true",
          },
        }
      : {}),
  },
  projects: [
    {
      name: "preview",
      // Os testes que mandam e-mail de verdade (tag @envia-email-real) só entram com o consentimento
      // explícito JNF_PREVIEW_ENVIA_EMAIL_REAL=1: a fumaça comum nunca envia mensagem alguma.
      ...(process.env.JNF_PREVIEW_ENVIA_EMAIL_REAL === "1"
        ? {}
        : { grepInvert: /@envia-email-real/ }),
      use: { browserName: "chromium" as const },
    },
  ],
});

const configLocal = defineConfig({
  testDir: "tests/e2e",
  testIgnore: /preview\//,
  outputDir: `test-results/e2e-${porta}`,
  reporter: "list",
  fullyParallel: true,
  // Três processos de teste, não os cinco que o padrão daria nesta máquina. Todos falam com UM servidor
  // de desenvolvimento (um só processo do Node): o trabalho dele é a fila, e com cinco clientes cada
  // teste esperava a vez dos outros quatro. Medido em `admin-mfa.spec.ts` (16 testes): cinco processos,
  // 57 s no total e até 20 s num teste; três, 58,6 s no total e até 11 s; o tempo total quase não muda.
  workers: 3,
  forbidOnly: true,
  // Compila as rotas do servidor de desenvolvimento antes do primeiro teste (ver o arquivo).
  globalSetup: "./tests/support/aquecer-servidor.ts",
  use: { baseURL: `http://localhost:${porta}` },
  webServer: {
    command: comandoServidor,
    url: `http://localhost:${porta}`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    timeout: 120_000,
  },
  projects: [
    {
      name: "celular",
      grepInvert: /@varredura|@medicao-tempo/,
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
      grepInvert: /@varredura|@medicao-tempo/,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 800 },
        colorScheme: "light",
      },
    },
    // A medição de tempo percebido (60 pares, de 1 a 1,5 minuto) não é portão: o projeto só existe com
    // JNF_MEDIR_TEMPO=1, que o `pnpm medir:tempo` define. Sem isso `pnpm test:e2e` nem a enxerga.
    ...(process.env.JNF_MEDIR_TEMPO
      ? [
          {
            name: "medicao-tempo",
            grep: /@medicao-tempo/,
            use: {
              browserName: "chromium" as const,
              viewport: { width: 1280, height: 800 },
              colorScheme: "light" as const,
            },
          },
        ]
      : []),
    varredura("varredura-320-claro", 320, 640, "light"),
    varredura("varredura-320-escuro", 320, 640, "dark"),
    varredura("varredura-360-claro", 360, 800, "light"),
    varredura("varredura-390-escuro", 390, 844, "dark"),
    varredura("varredura-1280-claro", 1280, 800, "light"),
    varredura("varredura-1280-escuro", 1280, 800, "dark"),
  ],
});

export default urlPreview ? configPreview : configLocal;
