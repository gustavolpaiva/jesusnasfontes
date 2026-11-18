import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { criarBancoPreparado, removerBancoDeExecucao } from "../../tests/support/banco-local";

// Executor de e2e isolado: cada execução tem banco, porta e diretório de build próprios,
// então duas execuções ao mesmo tempo não se atrapalham.

function portaLivre(): Promise<number> {
  return new Promise((resolver, rejeitar) => {
    const servidor = createServer();
    servidor.once("error", rejeitar);
    servidor.listen(0, "127.0.0.1", () => {
      const endereco = servidor.address();
      const porta = typeof endereco === "object" && endereco ? endereco.port : 0;
      servidor.close(() => resolver(porta));
    });
  });
}

async function main(): Promise<number> {
  const id = `${process.pid}-${randomBytes(3).toString("hex")}`;
  const distDir = `.next-e2e-${id}`;
  // O `next dev` acrescenta ao tsconfig.json as pastas de tipos do distDir desta execução;
  // o arquivo volta ao conteúdo original no fim para não sujar a árvore.
  const tsconfigOriginal = readFileSync("tsconfig.json", "utf8");
  mkdirSync("test-results", { recursive: true });
  // Cria e prepara; se a preparação falhar o banco já foi removido e o erro sobe.
  const { banco, env: envBanco } = await criarBancoPreparado();

  let codigo = 1;
  try {
    const porta = await portaLivre();
    const filho = spawn("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
      stdio: "inherit",
      env: {
        ...process.env,
        ...envBanco,
        ALVO_BANCO: "local",
        DATABASE_URL_OWNER: banco.url,
        PORTA_E2E: String(porta),
        NEXT_DIST_DIR: distDir,
        // Segredo da biblioteca de entrada: aleatório por execução, nunca o do cofre.
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        MAIL_TRANSPORT: "arquivo",
        MAIL_DIR: `test-results/correio-${id}`,
        // Saída do servidor, lida pelos testes que provam que texto privado não vai a registro.
        JNF_LOG_SERVIDOR: `test-results/servidor-${id}.log`,
      },
    });
    for (const sinal of ["SIGINT", "SIGTERM"] as const) {
      process.on(sinal, () => filho.kill(sinal));
    }
    codigo = await new Promise<number>((resolver) => {
      filho.on("exit", (saida, sinal) => resolver(saida ?? (sinal ? 1 : 0)));
    });
  } finally {
    await removerBancoDeExecucao(banco.nome).catch((erro) => {
      console.error(`Não foi possível remover o banco ${banco.nome}: ${String(erro)}`);
    });
    rmSync(distDir, { recursive: true, force: true });
    writeFileSync("tsconfig.json", tsconfigOriginal);
  }
  return codigo;
}

main().then(
  (codigo) => process.exit(codigo),
  (erro) => {
    console.error(erro);
    process.exit(1);
  },
);
