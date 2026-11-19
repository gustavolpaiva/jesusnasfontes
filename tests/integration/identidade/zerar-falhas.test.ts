import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { convite, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { aceitarConvite, convidar } from "@/modules/identidade/convite";
import { chaveFalhasDoCodigo, reservarPalpite, zerarLimite } from "@/modules/identidade/limite";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// As falhas do código de um endereço só zeram numa entrada BEM-SUCEDIDA dele (aceitarConvite é o
// ponto por onde passam a entrada pelo link e a entrada pelo código). Pedir novo acesso não zera.

const criados: string[] = [];
const novo = (p: string) => {
  const e = `${p}-${randomBytes(5).toString("hex")}@convite.example`;
  criados.push(e);
  return e;
};

async function esgotar(email: string) {
  await obterDb().execute(sql`
    insert into admin.tentativa (chave, janela_inicio, contagem)
    values (${chaveFalhasDoCodigo(email)}, now(), 10)
    on conflict (chave) do update set janela_inicio = now(), contagem = 10`);
}

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  process.env.MAIL_TRANSPORT = "arquivo";
  process.env.MAIL_DIR = mkdtempSync(join(tmpdir(), "jnf-zerar-"));
  process.env.APP_URL = "http://localhost:3999";
});

afterAll(async () => {
  const db = obterDb();
  for (const e of criados) await zerarLimite(chaveFalhasDoCodigo(e));
  await db.delete(convite).where(inArray(convite.emailNorm, criados));
  await db.delete(usuario).where(inArray(usuario.email, criados));
  await db.delete(verificacao).where(like(verificacao.identifier, "equivalente-%"));
  await db.delete(verificacao).where(eq(verificacao.identifier, "x"));
  await obterPool().end();
});

describe("falhas do código: só a entrada bem-sucedida zera", () => {
  it("teto atingido → entrada aceita (link ou código) → o código volta a ser comparado", async () => {
    const email = novo("entrou");
    await convidar(email, null, { enviar: false });
    await esgotar(email);
    expect((await reservarPalpite(chaveFalhasDoCodigo(email))).concedido).toBe(false);
    await esgotar(email);
    await aceitarConvite(email);
    expect((await reservarPalpite(chaveFalhasDoCodigo(email))).concedido).toBe(true);
  });

  it("controle negativo: teto atingido → pedir novo acesso sem entrar → continua recusado", async () => {
    const { darAcesso } = await import("@/modules/identidade/acesso");
    const convidado = novo("convidado");
    const desconhecido = novo("fora");
    await convidar(convidado, null, { enviar: false });
    for (const e of [convidado, desconhecido]) {
      await esgotar(e);
      await darAcesso(e, new Headers({ "x-real-ip": "10.9.9.8" }));
      await new Promise((r) => setTimeout(r, 200));
      expect((await reservarPalpite(chaveFalhasDoCodigo(e))).concedido).toBe(false);
    }
  });
});
