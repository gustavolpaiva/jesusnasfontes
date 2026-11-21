import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { criarBancoPreparado, removerBancoDeExecucao } from "../../tests/support/banco-local";
import { semearConteudo, semearTexto } from "../../tests/support/preparar-banco";

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
  // O `next dev` reescreve o arquivo de configuração do TypeScript que usa (acrescenta as pastas de tipos do distDir).
  // Cada execução usa o SEU arquivo, que estende o tsconfig.json e é removido no fim: nenhuma execução toca o
  // arquivo compartilhado, e duas ao mesmo tempo não restauram instantâneos uma por cima da outra (revisão da fase,
  // plano 01-20).
  const tsconfigDaExecucao = `.next-e2e-${id}.tsconfig.json`;
  writeFileSync(tsconfigDaExecucao, `${JSON.stringify({ extends: "./tsconfig.json" })}\n`);
  mkdirSync("test-results", { recursive: true });
  // Cria e prepara; se a preparação falhar o banco já foi removido e o erro sobe.
  const { banco, env: envBanco } = await criarBancoPreparado();

  let codigo = 1;
  try {
    // Texto e Estudos no banco da execução, para que todo e2e tenha o que ler: os quatro evangelhos
    // e 1 Coríntios (livros 40 a 43 e 46) e a pasta de conteúdo de `E2E_CONTEUDO_DIR` (padrão content/).
    await semearTexto({ livros: [40, 41, 42, 43, 46] }, envBanco);
    await semearConteudo(path.resolve(process.env.E2E_CONTEUDO_DIR ?? "content"), envBanco);
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
        NEXT_TSCONFIG: tsconfigDaExecucao,
        // Segredo da biblioteca de entrada: aleatório por execução, nunca o do cofre.
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        MAIL_TRANSPORT: "arquivo",
        // Responsável e contato do aviso de privacidade: valores de teste, nunca os do cofre.
        AVISO_RESPONSAVEL: "Responsável de teste",
        AVISO_CONTATO: "contato@convite.example",
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
    // O servidor de desenvolvimento ainda pode estar gravando no diretório de build quando o
    // Playwright o encerra (o `rmSync` falhou com ENOTEMPTY depois de 133 testes passarem): tenta de
    // novo por alguns segundos e, se ainda assim não sair, avisa SEM trocar o resultado dos testes.
    try {
      rmSync(distDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    } catch (erro) {
      console.error(`Não foi possível remover ${distDir}: ${String(erro)}`);
    }
    rmSync(tsconfigDaExecucao, { force: true });
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
