import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import { bootstrapPapeis } from "../../scripts/db/bootstrap-papeis";
import { type Ambiente, executarMigracoes } from "../../scripts/db/migrar";
import { urlDoPapel } from "../../src/db/url";

// Prepara um banco local descartável como o banco real é preparado: bootstrap dos papéis e
// migrações. O contêiner local confia em qualquer conexão, então as senhas aleatórias de cada
// execução só servem para exercitar o mesmo caminho de URL do Neon.

export type BancoPreparavel = { nome: string; url: string };

export async function prepararBanco(
  banco: BancoPreparavel,
  ambiente: Ambiente = "dev",
): Promise<Record<string, string>> {
  const endereco = new URL(banco.url);
  const senha = () => randomBytes(18).toString("hex");
  const env: Record<string, string> = {
    NEON_HOST: endereco.host,
    NEON_DATABASE: banco.nome,
    JNF_APP_PASSWORD: senha(),
    JNF_MIGRA_PASSWORD: senha(),
    JNF_CARGA_PASSWORD: senha(),
    JNF_ASSISTENTE_PASSWORD: senha(),
    DATABASE_URL_OWNER: banco.url,
  };

  // Papéis são globais no cluster: serializa o bootstrap entre execuções simultâneas.
  const trava = new pg.Client({ connectionString: new URL("/postgres", banco.url).toString() });
  await trava.connect();
  try {
    await trava.query("select pg_advisory_lock(hashtext('jnf-bootstrap-teste'))");
    await bootstrapPapeis(banco.url, {
      app: env.JNF_APP_PASSWORD as string,
      migra: env.JNF_MIGRA_PASSWORD as string,
      carga: env.JNF_CARGA_PASSWORD as string,
      assistente: env.JNF_ASSISTENTE_PASSWORD as string,
    });
  } finally {
    await trava.end();
  }

  await executarMigracoes({ url: urlDoPapel("migra", { agrupada: false }, env), ambiente });
  return env;
}

// Chamado no início de cada arquivo de teste de banco: no modo local aplica ao processo o
// ambiente do banco da execução; no modo neon as variáveis já vêm do cofre.
export function aplicarEnvDeTeste(): void {
  if (inject("alvoBanco") === "neon") return;
  const env = JSON.parse(inject("envBancoExecucao")) as Record<string, string>;
  Object.assign(process.env, env);
}
