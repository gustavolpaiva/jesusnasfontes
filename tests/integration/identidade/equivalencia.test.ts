import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { convite, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// Propriedade ESTRUTURAL do pedido de acesso: endereço convidado e não convidado executam as
// mesmas operações de banco, na mesma ordem e com a mesma forma, e respondem igual. É
// determinística (não depende de tempo) e é o que sustenta a resposta com tempo comparável.

const pasta = mkdtempSync(join(tmpdir(), "jnf-equiv-"));
const criados: string[] = [];
const novo = (p: string) => {
  const e = `${p}-${randomBytes(5).toString("hex")}@convite.example`;
  criados.push(e);
  return e;
};

// Reduz cada SQL a "verbo tabela" (sem parâmetros), para comparar a forma das operações.
function rotulo(sql: string): string {
  const texto = sql.replace(/\s+/g, " ").trim();
  const verbo = /^(select|insert into|delete from|update|begin|commit|rollback)/i.exec(texto)?.[1];
  const tabela = /"(\w+)"\."(\w+)"/.exec(texto);
  return `${(verbo ?? texto.slice(0, 12)).toLowerCase()} ${tabela ? `${tabela[1]}.${tabela[2]}` : ""}`.trim();
}

let registro: string[] | null = null;
const original = pg.Client.prototype.query;

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  process.env.MAIL_TRANSPORT = "arquivo";
  process.env.MAIL_DIR = pasta;
  process.env.APP_URL = "http://localhost:3999";
  // biome-ignore lint/suspicious/noExplicitAny: espião sobre a assinatura sobrecarregada do pg
  (pg.Client.prototype as any).query = function (this: unknown, ...args: any[]) {
    const primeiro = args[0];
    const texto = typeof primeiro === "string" ? primeiro : primeiro?.text;
    if (registro && typeof texto === "string") registro.push(rotulo(texto));
    // biome-ignore lint/suspicious/noExplicitAny: repassa tal e qual
    return (original as any).apply(this, args);
  };
});

afterAll(async () => {
  pg.Client.prototype.query = original;
  const db = obterDb();
  for (const e of criados) {
    await db.delete(convite).where((await import("drizzle-orm")).eq(convite.emailNorm, e));
    await db.delete(usuario).where((await import("drizzle-orm")).eq(usuario.email, e));
  }
  await db
    .delete(verificacao)
    .where((await import("drizzle-orm")).like(verificacao.identifier, "equivalente-%"));
  await obterPool().end();
});

async function operacoes(email: string): Promise<string[]> {
  const { darAcesso } = await import("@/modules/identidade/acesso");
  registro = [];
  await darAcesso(email, new Headers({ "x-real-ip": "10.9.9.9" }));
  await new Promise((r) => setTimeout(r, 300)); // o que roda depois da resposta (waitUntil)
  const visto = registro;
  registro = null;
  return visto;
}

describe("pedido de acesso: convidado e não convidado fazem o mesmo trabalho", () => {
  it("mesmas operações de banco, na mesma ordem e forma; o e-mail só sai para o convidado", async () => {
    const { convidar } = await import("@/modules/identidade/convite");
    const conv = novo("conv");
    const nao = novo("nao");
    await convidar(conv, null, { enviar: false });
    const antesEmails = readdirSync(pasta).length;

    const doConvidado = await operacoes(conv);
    const emailsConvidado = readdirSync(pasta).length - antesEmails;
    const doNao = await operacoes(nao);
    const emailsNao = readdirSync(pasta).length - antesEmails - emailsConvidado;

    // Controle positivo: o instrumento enxerga as operações e o convidado de fato recebeu e-mail.
    expect(doConvidado.length).toBeGreaterThanOrEqual(5);
    expect(emailsConvidado).toBe(1);
    expect(emailsNao).toBe(0);
    // O não convidado repete, na mesma ordem, tudo o que o convidado faz antes da resposta; o que
    // sobra é só a limpeza, depois da resposta, das duas linhas de nome aleatório que criou.
    expect(doNao.slice(0, doConvidado.length)).toEqual(doConvidado);
    expect(doNao.slice(doConvidado.length)).toEqual(["delete from auth.verification"]);
  });
});
