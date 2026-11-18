import { randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { convite, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import {
  aceitarConvite,
  apagarCodigoDe,
  ConviteDuplicado,
  convidar,
  conviteAtivo,
} from "@/modules/identidade/convite";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Roda no banco descartável local e, pelo script test:integration:neon, no Neon dev. Só mexe nas
// linhas que cria (endereços únicos sob domínio reservado) e só apaga essas.

const criados: string[] = [];
const novo = (prefixo = "convite") => {
  const email = `${prefixo}-${randomBytes(5).toString("hex")}@convite.example`;
  criados.push(email);
  return email;
};

beforeAll(() => aplicarEnvDeTeste());
afterAll(async () => {
  const db = obterDb();
  await db.delete(verificacao).where(
    inArray(
      verificacao.identifier,
      criados.map((e) => `sign-in-otp-${e}`),
    ),
  );
  await db.delete(convite).where(inArray(convite.emailNorm, criados));
  await db.delete(usuario).where(inArray(usuario.email, criados));
  await obterPool().end();
});

describe("convite", () => {
  it("convidar cria o convite pendente e o usuário estudante", async () => {
    const email = novo();
    expect(await conviteAtivo(email)).toBe(false); // controle: antes de convidar não há convite
    await convidar(email, null, { enviar: false });
    expect(await conviteAtivo(email)).toBe(true);
    const linha = await obterDb().select().from(convite).where(eq(convite.emailNorm, email));
    expect(linha[0]?.estado).toBe("pendente");
    const conta = await obterDb().select().from(usuario).where(eq(usuario.email, email));
    expect(conta).toHaveLength(1);
    expect(conta[0]?.role).toBe("estudante");
    expect(conta[0]?.emailVerified).toBe(false);
  });

  it("convite duplicado lança ConviteDuplicado, pendente ou aceito", async () => {
    const email = novo();
    await convidar(email, null, { enviar: false });
    await expect(convidar(email, null, { enviar: false })).rejects.toBeInstanceOf(ConviteDuplicado);
    await aceitarConvite(email);
    await expect(convidar(email, null, { enviar: false })).rejects.toBeInstanceOf(ConviteDuplicado);
    expect(await conviteAtivo(email)).toBe(true); // aceito continua valendo
  });

  it("conviteAtivo é falso para revogado e para inexistente; convidar de novo reativa", async () => {
    const email = novo();
    await convidar(email, null, { enviar: false });
    await obterDb()
      .update(convite)
      .set({ estado: "revogado", revogadoEm: new Date() })
      .where(eq(convite.emailNorm, email));
    expect(await conviteAtivo(email)).toBe(false);
    expect(await conviteAtivo(novo("nunca-convidado"))).toBe(false);
    await convidar(email, null, { enviar: false });
    expect(await conviteAtivo(email)).toBe(true);
  });

  it("o endereço é normalizado antes de gravar: maiúsculas e espaços não criam duplicata", async () => {
    const email = novo("normal");
    await convidar(`  ${email.toUpperCase()}  `, null, { enviar: false });
    await expect(convidar(email, null, { enviar: false })).rejects.toBeInstanceOf(ConviteDuplicado);
    expect(await conviteAtivo(email.toUpperCase())).toBe(true);
    const linhas = await obterDb().select().from(convite).where(eq(convite.emailNorm, email));
    expect(linhas).toHaveLength(1);
    const contas = await obterDb().select().from(usuario).where(eq(usuario.email, email));
    expect(contas).toHaveLength(1);
  });

  it("aceitar o convite apaga o código pendente daquele endereço e só dele", async () => {
    const email = novo("aceita");
    const outro = novo("fica");
    for (const e of [email, outro]) {
      await convidar(e, null, { enviar: false });
      await obterDb()
        .insert(verificacao)
        .values({
          identifier: `sign-in-otp-${e}`,
          value: "x:0",
          expiresAt: new Date(Date.now() + 600_000),
        });
    }
    await aceitarConvite(email);
    const restam = await obterDb()
      .select()
      .from(verificacao)
      .where(inArray(verificacao.identifier, [`sign-in-otp-${email}`, `sign-in-otp-${outro}`]));
    expect(restam.map((l) => l.identifier)).toEqual([`sign-in-otp-${outro}`]);
  });

  it("esgotar o código apaga só o código daquele endereço: link dele e tudo do outro ficam", async () => {
    const a = novo("esgota");
    const b = novo("outro");
    const expira = new Date(Date.now() + 600_000);
    const link = (e: string) => JSON.stringify({ type: "magic-link", email: e });
    await obterDb()
      .insert(verificacao)
      .values([
        { identifier: `sign-in-otp-${a}`, value: "x:0", expiresAt: expira },
        { identifier: `magic-link:h-${a}`, value: link(a), expiresAt: expira },
        { identifier: `sign-in-otp-${b}`, value: "x:0", expiresAt: expira },
        { identifier: `magic-link:h-${b}`, value: link(b), expiresAt: expira },
      ]);
    await apagarCodigoDe(a);
    const restam = await obterDb()
      .select()
      .from(verificacao)
      .where(
        inArray(verificacao.identifier, [
          `sign-in-otp-${a}`,
          `magic-link:h-${a}`,
          `sign-in-otp-${b}`,
          `magic-link:h-${b}`,
        ]),
      );
    expect(restam.map((l) => l.identifier).sort()).toEqual(
      [`magic-link:h-${a}`, `sign-in-otp-${b}`, `magic-link:h-${b}`].sort(),
    );
    await obterDb()
      .delete(verificacao)
      .where(
        inArray(verificacao.identifier, [
          `magic-link:h-${a}`,
          `sign-in-otp-${b}`,
          `magic-link:h-${b}`,
        ]),
      );
  });
});
