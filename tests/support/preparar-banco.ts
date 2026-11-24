import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";
import type { ResultadoFontes } from "../../scripts/acervo/carregar";
import type { ResultadoConteudo } from "../../scripts/content/carregar";
import { bootstrapPapeis } from "../../scripts/db/bootstrap-papeis";
import { type Ambiente, executarMigracoes } from "../../scripts/db/migrar";
import type { ResultadoCarga } from "../../scripts/ingest/carregar-biblia";
import { urlDoPapel } from "../../src/db/url";

// Prepara um banco local descartável como o banco real é preparado: bootstrap dos papéis e
// migrações. O contêiner local confia em qualquer conexão, então as senhas aleatórias de cada
// execução só servem para exercitar o mesmo caminho de URL do Neon.

export type BancoPreparavel = { nome: string; url: string };

export async function prepararBanco(
  banco: BancoPreparavel,
  ambiente: Ambiente = "dev",
): Promise<Record<string, string>> {
  // O banco preparável é sempre o descartável local: sem parâmetros de URL e destino efetivo local.
  const sonda = new pg.Client({ connectionString: banco.url });
  if (
    /[?#]/.test(banco.url) ||
    !["127.0.0.1", "localhost"].includes(String((sonda as { host?: unknown }).host))
  ) {
    throw new Error("Recusado: prepararBanco só aceita o banco descartável local.");
  }
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

// ───────────────────────── dados para os testes de ponta a ponta ─────────────────────────

type FonteDeEnv = Record<string, string | undefined>;

// Cliente de carga (jnf_carga) do banco DA EXECUÇÃO: o ambiente dele pode não ser o do processo (o
// executor de e2e prepara o banco no processo pai e entrega o ambiente só ao filho).
async function comCarga<T>(env: FonteDeEnv, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({
    connectionString: urlDoPapel("carga", { agrupada: false }, env),
  });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end().catch(() => {});
  }
}

/**
 * Carrega no banco da execução SÓ os livros pedidos (números 1 a 66) da edição exibida (n4), pelos
 * arquivos de `data/raw/` conferidos pelo lock, pelo mesmo `interpretarF4` e `carregarEdicao` do
 * `ingest:biblia`. Sem a conferência de totais da Bíblia inteira: o que vale é a validação parcial.
 */
export async function semearTexto(
  opcoes: { livros: readonly number[] },
  env: FonteDeEnv = process.env,
): Promise<ResultadoCarga> {
  // Importações tardias: este arquivo é carregado por testes que trocam módulos do banco por
  // simulados (`vi.mock`), e a cadeia da carga os importaria antes do simulado existir.
  const { carregarEdicao, conjuntoDoRegistro, ErroCarga, lerEdicaoVerificada, shaDoLock } =
    await import("../../scripts/ingest/carregar-biblia");
  const { lerRegistro } = await import("../../scripts/ingest/fontes");
  const { carregarTabela } = await import("../../scripts/ingest/parser-f4");
  const tabela = carregarTabela();
  const arquivos = opcoes.livros.map((livro) => {
    const linha = tabela.find((l) => l.livro === livro);
    if (!linha) throw new ErroCarga(`livro ${livro} fora da tabela`);
    return linha.arquivo;
  });
  const lida = await lerEdicaoVerificada("n4", { arquivos });
  const conjunto = conjuntoDoRegistro(await lerRegistro(), await shaDoLock());
  return comCarga(env, (cliente) =>
    carregarEdicao(lida.versiculos, {
      edicao: "n4",
      conjunto,
      marcadores: lida.marcadores,
      mesclados: lida.mesclados,
      cliente,
    }),
  );
}

/** Roda a carga de conteúdo (`content:load`) sobre a pasta indicada, no banco da execução. */
export async function semearConteudo(
  pasta: string,
  env: FonteDeEnv = process.env,
): Promise<ResultadoConteudo> {
  const { carregarConteudo } = await import("../../scripts/content/carregar");
  const { lerPasta } = await import("../../scripts/content/esquema");
  const conteudo = await lerPasta(pasta);
  return comCarga(env, (cliente) => carregarConteudo(conteudo, { cliente }));
}

/**
 * Carrega no banco da execução as Fontes de `<pasta>/fontes/*.yaml` com o derivado de cada uma em
 * `<pasta>/derivados/<slug>.json`, pela mesma `carregarFontes` do `acervo:load`, sem rede e sem lock
 * (o lock é do conteúdo real; a fixture é um recorte de teste).
 */
export async function semearAcervo(
  pasta: string,
  env: FonteDeEnv = process.env,
): Promise<ResultadoFontes> {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const { carregarFontes } = await import("../../scripts/acervo/carregar");
  const { interpretarDerivado, interpretarFonteYaml } = await import(
    "../../src/modules/acervo/schemas"
  );
  const dirFontes = path.join(pasta, "fontes");
  const { existsSync } = await import("node:fs");
  const itens = readdirSync(dirFontes)
    .filter((nome) => nome.endsWith(".yaml"))
    .sort()
    .flatMap((nome) => {
      const fonte = interpretarFonteYaml(readFileSync(path.join(dirFontes, nome), "utf8"), nome);
      const arquivo = `${fonte.slug}.json`;
      const caminho = path.join(pasta, "derivados", arquivo);
      // Como o `acervo:load`: Fonte não publicada e sem derivado é pulada (a fixture de Mara bar Serapião, do plano
      // 02-08, é carregada direto pelo teste dela, com o derivado em memória). Publicada e sem derivado é erro.
      if (!existsSync(caminho)) {
        if (fonte.publicada)
          throw new Error(`semearAcervo: Fonte ${fonte.slug} publicada e sem derivado`);
        return [];
      }
      const derivado = interpretarDerivado(JSON.parse(readFileSync(caminho, "utf8")), arquivo);
      return [{ fonte, derivado }];
    });
  return comCarga(env, (cliente) => carregarFontes(itens, { cliente }));
}

/**
 * Carrega no banco da execução as Fontes REAIS do repositório (`content/acervo/fontes` com o derivado conferido pelo
 * lock), como o `acervo:load`. Só para a conferência visual com `E2E_ACERVO_REAL=1`: sobrescreve a fixture do mesmo
 * slug (o Josefo) pelo texto completo.
 */
export async function semearAcervoReal(env: FonteDeEnv = process.env): Promise<ResultadoFontes> {
  const { readFileSync, readdirSync } = await import("node:fs");
  const path = await import("node:path");
  const { carregarFontes } = await import("../../scripts/acervo/carregar");
  const { CAMINHO_LOCK, PASTA_DERIVADOS, lerDerivado, lerLock, verificarDerivados } = await import(
    "../../scripts/acervo/derivados"
  );
  const { interpretarFonteYaml } = await import("../../src/modules/acervo/schemas");
  const lock = lerLock(CAMINHO_LOCK);
  verificarDerivados(PASTA_DERIVADOS, lock);
  const dir = path.resolve("content", "acervo", "fontes");
  const itens = readdirSync(dir)
    .filter((nome) => nome.endsWith(".yaml"))
    .sort()
    .flatMap((nome) => {
      const fonte = interpretarFonteYaml(readFileSync(path.join(dir, nome), "utf8"), nome);
      // Como o `acervo:load`: não publicada e sem derivado é pulada (o Suetônio do plano 02-09); publicada e
      // sem derivado é erro.
      if (!lock.derivados[fonte.slug]) {
        if (fonte.publicada)
          throw new Error(`semearAcervoReal: Fonte ${fonte.slug} publicada e sem derivado`);
        return [];
      }
      return [{ fonte, derivado: lerDerivado(PASTA_DERIVADOS, lock, fonte.slug) }];
    });
  return comCarga(env, (cliente) => carregarFontes(itens, { cliente }));
}
