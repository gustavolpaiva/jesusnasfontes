import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { comEstudante } from "@/db/com-estudante";
import { usuario } from "@/db/schema/fundacao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// Um erro de banco carrega os parâmetros da consulta (token de sessão, código, e-mail, texto
// privado). Nada que imprima o erro inteiro pode vazar o parâmetro: nem o logger da biblioteca de
// entrada, nem um `throw` não tratado, nem uma consulta nossa que falha.

const marcador = `MARCADOR-${randomUUID()}`;
const segredo = randomBytes(32).toString("hex");
const assinado = (v: string) =>
  encodeURIComponent(`${v}.${createHmac("sha256", segredo).update(v).digest("base64")}`);

let saida: string[] = [];
const parametrosVistos: unknown[][] = [];
const original = pg.Client.prototype.query;

function capturar() {
  const espioes = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      saida.push(a.map((x) => (typeof x === "string" ? x : inspect(x, { depth: null }))).join(" "));
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

// Tudo o que uma impressão do erro mostraria, em profundidade total e com propriedades ocultas.
function tudoDe(erro: unknown): string {
  return inspect(erro, { depth: null, showHidden: true, getters: true });
}

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = segredo;
  process.env.APP_URL = "http://localhost:3999";
  // Controle: vê os parâmetros que de fato chegam ao banco.
  // biome-ignore lint/suspicious/noExplicitAny: espião sobre a assinatura sobrecarregada do pg
  (pg.Client.prototype as any).query = function (this: unknown, ...args: any[]) {
    const p = args[0]?.values ?? args[1];
    if (Array.isArray(p)) parametrosVistos.push(p);
    // biome-ignore lint/suspicious/noExplicitAny: repassa tal e qual
    return (original as any).apply(this, args);
  };
});
afterAll(async () => {
  pg.Client.prototype.query = original;
  await obterPool().end();
});

describe("o parâmetro de uma consulta que falha não vaza", () => {
  it("controle do instrumento: a captura enxerga o que é escrito", () => {
    saida = [];
    const solta = capturar();
    console.error(marcador);
    process.stderr.write(`${marcador}\n`);
    solta();
    expect(saida.join("\n")).toContain(marcador);
  });

  it("(a) rota da biblioteca com erro de banco: o token de sessão não vai à saída", async () => {
    const pool = obterPool();
    pool.on("connect", (c) => void c.query("set statement_timeout = 100"));
    const dono = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await dono.connect();
    await dono.query("begin");
    await dono.query("lock table auth.session in access exclusive mode");
    saida = [];
    parametrosVistos.length = 0;
    const solta = capturar();
    let status = 0;
    try {
      const { obterAuth } = await import("@/lib/auth");
      const { toNextJsHandler } = await import("better-auth/next-js");
      const r = await toNextJsHandler(obterAuth()).GET(
        new Request("http://localhost:3999/api/auth/get-session", {
          headers: { cookie: `better-auth.session_token=${assinado(marcador)}` },
        }),
      );
      status = r.status;
    } finally {
      solta();
      await dono.query("rollback");
      await dono.end();
    }
    // Controles positivos: o marcador foi mesmo parâmetro da consulta e o erro aconteceu.
    expect(parametrosVistos.some((p) => p.includes(marcador))).toBe(true);
    expect(status).toBe(500);
    expect(saida.join("\n")).toContain("57014"); // o registro existe e leva o código
    expect(saida.join("\n")).not.toContain(marcador);
  });

  it("(a2) o logger da biblioteca nunca imprime o que recebe", async () => {
    const { obterAuth } = await import("@/lib/auth");
    const contexto = await obterAuth().$context;
    saida = [];
    const solta = capturar();
    const bruto = Object.assign(new Error(`falha ${marcador}`), {
      params: [marcador],
      query: `select ${marcador}`,
      cause: { code: "57014", detail: marcador },
    });
    contexto.logger.error("INTERNAL_SERVER_ERROR", bruto);
    contexto.logger.warn(`texto livre ${marcador}`, bruto);
    solta();
    expect(saida.join("\n")).toContain("better-auth-error");
    expect(saida.join("\n")).not.toContain(marcador);
  });

  it("(b) consulta nossa que falha: nem o erro nem a cadeia de causas levam o parâmetro", async () => {
    const email = `${marcador}@example.test`;
    const db = obterDb();
    const id = randomUUID();
    await db.insert(usuario).values({ id, email });
    parametrosVistos.length = 0;
    let erro: unknown;
    try {
      await db.insert(usuario).values({ id: randomUUID(), email });
    } catch (e) {
      erro = e;
    }
    await db.delete(usuario).where((await import("drizzle-orm")).eq(usuario.id, id));
    // Controles positivos: o erro aconteceu (unicidade), o marcador estava nos parâmetros, e o
    // que não é sensível ficou (código e nome da restrição).
    expect(erro).toBeInstanceOf(Error);
    expect((erro as { code?: string }).code).toBe("23505");
    expect((erro as { constraint?: string }).constraint).toMatch(/\w+/);
    expect(parametrosVistos.some((p) => p.includes(email))).toBe(true);
    expect(tudoDe(erro)).not.toContain(marcador);
    expect(JSON.stringify(erro, Object.getOwnPropertyNames(erro as object))).not.toContain(
      marcador,
    );
    expect((erro as { cause?: unknown }).cause).toBeUndefined();
  });

  it("(c) erro que escapa de uma ação do servidor e é impresso inteiro: sem o parâmetro", async () => {
    // O que o Next faz com um `throw` não tratado: imprime o erro inteiro.
    const acaoQueDeixaEscapar = async () =>
      comEstudante(randomUUID(), (tx) =>
        tx.insert(usuario).values({
          id: randomUUID(),
          email: `${marcador}-sem-papel@example.test`,
          role: marcador as never,
        }),
      );
    saida = [];
    const solta = capturar();
    let erro: unknown;
    try {
      await acaoQueDeixaEscapar();
    } catch (e) {
      erro = e;
      console.error(e);
    }
    solta();
    expect(erro).toBeInstanceOf(Error); // controle: houve erro de banco
    expect((erro as { code?: string }).code).toBeDefined();
    expect(saida.join("\n")).toContain("ErroDeBanco");
    expect(saida.join("\n")).not.toContain(marcador);
  });
});
