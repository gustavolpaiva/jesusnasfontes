import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { convite, doisFatores, sessao, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// O canário fica desabilitado em repouso. `desabilitar` precisa MEDIR que o convite foi revogado, que
// não sobrou sessão e que a sessão anterior deixou de valer. Aqui a sessão anterior é uma sessão REAL
// da biblioteca de entrada (cookie assinado): vale antes (controle positivo) e é recusada depois.

const segredo = randomBytes(32).toString("hex");
const rodada = randomUUID().slice(0, 8);
const ids: string[] = [];
const emails: string[] = [];

const emNeon = () => inject("alvoBanco") === "neon";

// O endereço do teste é o do canário marcado (a proteção só aceita o endereço de uma variável de canário)
// e nunca o Admin inicial.
function email(nome: string, papel: "estudante" | "admin" = "estudante") {
  const e = `${nome}-${rodada}-${randomUUID().slice(0, 6)}@example.test`;
  emails.push(e);
  process.env.JNF_CANARIO_ESTUDANTE_EMAIL = `outro-estudante-${rodada}@example.test`;
  process.env.JNF_CANARIO_ADMIN_EMAIL = `outro-admin-${rodada}@example.test`;
  process.env[papel === "admin" ? "JNF_CANARIO_ADMIN_EMAIL" : "JNF_CANARIO_ESTUDANTE_EMAIL"] = e;
  return e;
}

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = segredo;
  process.env.ADMIN_EMAIL_INICIAL = `admin-real-${rodada}@example.test`;
});

afterAll(async () => {
  if (!emNeon()) {
    await obterDb().delete(usuario).where(inArray(usuario.id, ids));
    await obterDb().delete(convite).where(inArray(convite.emailNorm, emails));
  }
  await obterPool().end();
});

async function cookieDe(token: string) {
  const { obterAuth } = await import("@/lib/auth");
  const ctx = await obterAuth().$context;
  const assinatura = createHmac("sha256", segredo).update(token).digest("base64");
  const valor = encodeURIComponent(`${token}.${assinatura}`);
  return `${ctx.authCookies.sessionToken.name}=${valor}`;
}

async function sessaoVista(token: string) {
  const { obterAuth } = await import("@/lib/auth");
  return obterAuth().api.getSession({ headers: new Headers({ cookie: await cookieDe(token) }) });
}

describe.skipIf(emNeon())("canario: habilitar e desabilitar, medidos", () => {
  it("habilitar sem --enviar não manda e-mail e deixa a entrada permitida; de novo é idempotente", async () => {
    const { habilitar } = await import("../../../scripts/dev/canario");
    const e = email("hab");
    const antes = process.env.MAIL_TRANSPORT;
    process.env.MAIL_TRANSPORT = "resend"; // se tentasse enviar, falharia sem chave: o teste enxerga
    try {
      const r = await habilitar(obterPool(), e, "estudante", false);
      expect(r.criado).toBe(true);
      expect(r.estado).toMatchObject({ convite: "pendente", entradaPermitida: true, sessoes: 0 });
      const de_novo = await habilitar(obterPool(), e, "estudante", false);
      expect(de_novo.criado).toBe(false);
      expect(de_novo.estado.entradaPermitida).toBe(true);
    } finally {
      if (antes === undefined) delete process.env.MAIL_TRANSPORT;
      else process.env.MAIL_TRANSPORT = antes;
    }
    const [u] = await obterDb().select().from(usuario).where(eq(usuario.email, e));
    if (u) ids.push(u.id);
  });

  it("desabilitar: convite revogado, nenhuma sessão, a sessão anterior recusada pela biblioteca", async () => {
    const { habilitar, desabilitar, lerEstado } = await import("../../../scripts/dev/canario");
    const e = email("des");
    await habilitar(obterPool(), e, "estudante", false);
    const [u] = await obterDb().select().from(usuario).where(eq(usuario.email, e));
    if (!u) throw new Error("usuário do teste não foi criado");
    ids.push(u.id);

    // Uma sessão real, criada pela própria biblioteca (passa pelo gancho do convite).
    const { obterAuth } = await import("@/lib/auth");
    const ctx = await obterAuth().$context;
    const criada = await ctx.internalAdapter.createSession(u.id);
    // Uma verificação pendente (link/código ainda não usado).
    await obterDb()
      .insert(verificacao)
      .values({
        identifier: `sign-in-otp-${e}`,
        value: "hash",
        expiresAt: new Date(Date.now() + 600_000),
      });
    // Controle positivo: antes, a biblioteca ENXERGA a sessão pelo cookie assinado.
    expect((await sessaoVista(criada.token))?.user.id).toBe(u.id);
    expect((await lerEstado(obterPool(), e)).sessoesValidas).toBe(1);

    const r = await desabilitar(obterPool(), e);
    expect(r.sessoesAnteriores).toBe(1);
    expect(r.estado).toMatchObject({ convite: "revogado", sessoes: 0, entradaPermitida: false });
    expect(r.confirmado).toBe(true);
    // Depois: a biblioteca recusa o mesmo cookie.
    expect(await sessaoVista(criada.token)).toBeNull();
    // E não nasce sessão nova para o endereço (o gancho de criação exige convite ativo).
    const nova = await ctx.internalAdapter.createSession(u.id).catch(() => null);
    expect(nova === null || nova === undefined || !nova.token).toBe(true);
    expect(await obterDb().select().from(sessao).where(eq(sessao.userId, u.id))).toHaveLength(0);
    expect(
      await obterDb()
        .select()
        .from(verificacao)
        .where(eq(verificacao.identifier, `sign-in-otp-${e}`)),
    ).toHaveLength(0);
  });

  it("negativo: conta habilitada e com sessão não é 'desabilitada' no estado, e estado diz isso", async () => {
    const { habilitar, lerEstado } = await import("../../../scripts/dev/canario");
    const e = email("neg");
    await habilitar(obterPool(), e, "estudante", false);
    const [u] = await obterDb().select().from(usuario).where(eq(usuario.email, e));
    if (!u) throw new Error("usuário do teste não foi criado");
    ids.push(u.id);
    const { obterAuth } = await import("@/lib/auth");
    await (await obterAuth().$context).internalAdapter.createSession(u.id);
    const s = await lerEstado(obterPool(), e);
    expect(s).toMatchObject({ convite: "pendente", sessoes: 1, entradaPermitida: true });
  });

  it("desabilitar de quem nunca foi convidado confirma sem erro (nada a revogar)", async () => {
    const { desabilitar } = await import("../../../scripts/dev/canario");
    const r = await desabilitar(obterPool(), email("nunca"));
    expect(r.sessoesAnteriores).toBe(0);
    expect(r.estado.convite).toBe("ausente");
    expect(r.confirmado).toBe(true);
  });

  it("Admin canário: habilitar zera o segundo fator velho e desabilitar mede que não sobra nenhum", async () => {
    const { habilitar, desabilitar } = await import("../../../scripts/dev/canario");
    const e = email("adm", "admin");
    await habilitar(obterPool(), e, "admin", false);
    const [u] = await obterDb().select().from(usuario).where(eq(usuario.email, e));
    if (!u) throw new Error("usuário do teste não foi criado");
    ids.push(u.id);
    expect(u.role).toBe("admin");
    const poe = () =>
      obterDb().insert(doisFatores).values({ secret: "x", backupCodes: "y", userId: u.id });
    const linhas = async () =>
      (await obterDb().select().from(doisFatores).where(eq(doisFatores.userId, u.id))).length;
    // Controle positivo: o fator velho existe antes; habilitar de novo o zera.
    await poe();
    expect(await linhas()).toBe(1);
    await habilitar(obterPool(), e, "admin", false);
    expect(await linhas()).toBe(0);
    // desabilitar também zera e só confirma com zero linhas.
    await poe();
    const r = await desabilitar(obterPool(), e);
    expect(r.segundosFatores).toBe(0);
    expect(r.confirmado).toBe(true);
    expect(await linhas()).toBe(0);
  });

  it("recusa banco que não é o de dev (o mesmo guarda do conferidor)", async () => {
    const { conferirAmbienteDev, NaoMedido } = await import(
      "../../../scripts/dev/conferir-entrada"
    );
    const prod = { query: async () => ({ rows: [{ nome: "producao" }] }) };
    await expect(conferirAmbienteDev(prod as never)).rejects.toBeInstanceOf(NaoMedido);
  });
});
