import { randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, inject, it, vi } from "vitest";
import { sessao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));
// Todo o processo deste arquivo usa um pool de UMA conexão: concessão e compensação não podem
// esperar por outra conexão enquanto seguram a trava.
vi.mock("@/db/cliente", async (original) => {
  const m = await original<typeof import("@/db/cliente")>();
  aplicarEnvDeTeste();
  const c = m.criarCliente({ max: 1 });
  return { ...m, obterCliente: () => c, obterDb: () => c.db, obterPool: () => c.pool };
});

const { obterDb, obterPool } = await import("@/db/cliente");
const { concederSegundoFator, desfazerAtivacao, estadoDoCadastro, sessaoVerificada } = await import(
  "@/modules/identidade/sessao-mfa"
);
void inject;

const contas: string[] = [];
async function criar() {
  const id = randomUUID();
  const sessaoId = randomUUID();
  await obterDb()
    .insert(usuario)
    .values({ id, email: `p1-${randomBytes(4).toString("hex")}@example.test`, role: "admin" });
  contas.push(id);
  await obterDb()
    .insert(sessao)
    .values({
      id: sessaoId,
      userId: id,
      token: randomBytes(24).toString("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  await obterDb().execute(
    sql`insert into auth.two_factor (secret, backup_codes, user_id, verified) values ('s', 'c', ${id}, true)`,
  );
  await obterDb().execute(sql`update auth."user" set two_factor_enabled = true where id = ${id}`);
  return { id, sessaoId };
}

afterAll(async () => {
  await obterDb().delete(usuario).where(inArray(usuario.id, contas));
  await obterPool().end();
});

describe("pool de tamanho 1", () => {
  it("concessão e compensação, sequenciais e simultâneas, terminam (sem espera cruzada) e ficam coerentes", async () => {
    const a = await criar();
    expect(await concederSegundoFator(a.id, a.sessaoId, 0)).toBe(true);
    await desfazerAtivacao(a.id);
    expect(await sessaoVerificada(a.sessaoId)).toBe(true);

    const b = await criar();
    const [conc] = await Promise.all([
      concederSegundoFator(b.id, b.sessaoId, 0),
      desfazerAtivacao(b.id),
      desfazerAtivacao(b.id),
    ]);
    const verificada = await sessaoVerificada(b.sessaoId);
    expect(verificada).toBe(conc);
    const ativo = (await obterDb().select().from(usuario).where(eq(usuario.id, b.id)))[0]
      ?.twoFactorEnabled;
    expect(ativo).toBe(verificada);
    expect(await estadoDoCadastro(b.id)).toBe(verificada ? "ativo" : "pendente");
  });
});
