import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { sessao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";
import { decodificarBase32 } from "../../support/totp";

vi.mock("server-only", () => ({}));

// Segredo de aplicativo, código de recuperação e token de sessão são credenciais: nenhum caminho de
// verificação do segundo fator pode deixá-los em registro, em erro impresso ou em relatório.
// Arquivo próprio: o espião de tempo limite precisa ser o primeiro a tocar o pool do processo.

const segredoDaBiblioteca = randomBytes(32).toString("hex");
const assinado = (v: string) =>
  encodeURIComponent(
    `${v}.${createHmac("sha256", segredoDaBiblioteca).update(v).digest("base64")}`,
  );
const contasCriadas: string[] = [];

async function criarAdminComSessao() {
  const id = randomUUID();
  await obterDb()
    .insert(usuario)
    .values({ id, email: `adm-${randomBytes(4).toString("hex")}@example.test`, role: "admin" });
  contasCriadas.push(id);
  const token = randomBytes(24).toString("hex");
  await obterDb()
    .insert(sessao)
    .values({ userId: id, token, expiresAt: new Date(Date.now() + 3_600_000) });
  return {
    id,
    token,
    cabecalhos: new Headers({ cookie: `better-auth.session_token=${assinado(token)}` }),
  };
}

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = segredoDaBiblioteca;
  process.env.APP_URL = "http://localhost:3999";
  // Toda conexão do pool nasce com tempo limite curto (antes de qualquer consulta do arquivo): a
  // consulta que esbarra na tabela travada estoura em vez de esperar para sempre.
  obterPool().on("connect", (c) => void c.query("set statement_timeout = 1500"));
});
afterAll(async () => {
  const { inArray } = await import("drizzle-orm");
  if (contasCriadas.length > 0)
    await obterDb().delete(usuario).where(inArray(usuario.id, contasCriadas));
  await obterPool().end();
});

// Tudo o que uma impressão mostraria.
const tudoDe = (erro: unknown) => inspect(erro, { depth: null, showHidden: true, getters: true });

describe("nenhum caminho de verificação deixa segredo, código ou token em registro", () => {
  const marcadorDeCodigo = `MARCADOR-${randomUUID()}`;
  let saida: string[] = [];
  function capturar() {
    const espioes = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        saida.push(
          a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: null }))).join(" "),
        );
      }),
    );
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const guardar = (p: unknown) => {
      saida.push(String(p));
      return true;
    };
    process.stdout.write = guardar as typeof process.stdout.write;
    process.stderr.write = guardar as typeof process.stderr.write;
    return () => {
      process.stdout.write = out;
      process.stderr.write = err;
      for (const e of espioes) e.mockRestore();
    };
  }

  it("erro de banco forçado durante a verificação do aplicativo e do código de recuperação", async () => {
    const { obterAuth } = await import("@/lib/auth");
    const a = await criarAdminComSessao();
    const criado = (await obterAuth().api.enableTwoFactor({
      body: {},
      headers: a.cabecalhos,
    })) as { totpURI: string; backupCodes: string[] };
    const segredoEmClaro = new URL(criado.totpURI).searchParams.get("secret") as string;
    const codigoDeRecuperacao = criado.backupCodes[0] as string;
    const sensiveis = [
      segredoEmClaro,
      decodificarBase32(segredoEmClaro).toString(),
      codigoDeRecuperacao,
      a.token,
      marcadorDeCodigo,
    ];

    // Trava a tabela do segundo fator: a consulta estoura o tempo e o banco devolve o erro.
    const dono = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await dono.connect();
    await dono.query("begin");
    await dono.query("lock table auth.two_factor in access exclusive mode");
    saida = [];
    const solta = capturar();
    const erros: unknown[] = [];
    try {
      for (const chamada of [
        () => obterAuth().api.verifyTOTP({ body: { code: "123456" }, headers: a.cabecalhos }),
        () =>
          obterAuth().api.verifyBackupCode({
            body: { code: codigoDeRecuperacao, disableSession: true },
            headers: a.cabecalhos,
          }),
        () =>
          obterAuth().api.verifyBackupCode({
            body: { code: marcadorDeCodigo, disableSession: true },
            headers: a.cabecalhos,
          }),
      ]) {
        try {
          await chamada();
        } catch (e) {
          erros.push(e);
          console.error(e); // o que o Next faz com um erro que escapa
        }
      }
    } finally {
      solta();
      await dono.query("rollback");
      await dono.end();
    }
    const tudo = `${saida.join("\n")}\n${erros.map(tudoDe).join("\n")}`;
    // Controles positivos: houve erro de banco (tempo estourado) em todas as três chamadas, e o
    // registro existe e leva o código SQLSTATE.
    expect(erros).toHaveLength(3);
    expect(tudo).toContain("57014");
    for (const s of sensiveis) expect(tudo, "vazou um segredo").not.toContain(s);
  });

  it("o logger da biblioteca nunca imprime o que recebe (segredo de aplicativo e código de recuperação)", async () => {
    const { obterAuth } = await import("@/lib/auth");
    const contexto = await obterAuth().$context;
    saida = [];
    const solta = capturar();
    const bruto = Object.assign(new Error(`falha ${marcadorDeCodigo}`), {
      params: [marcadorDeCodigo],
      cause: { code: "57014", detail: marcadorDeCodigo },
    });
    contexto.logger.error("INTERNAL_SERVER_ERROR", bruto);
    contexto.logger.error("totp isn't configured", { secret: marcadorDeCodigo });
    solta();
    expect(saida.join("\n")).toContain("better-auth-error"); // controle: o registro saiu
    expect(saida.join("\n")).not.toContain(marcadorDeCodigo);
  });
});
