import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { convite, sessao, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { apagarCodigoDe, convidar } from "@/modules/identidade/convite";
import { chaveFalhasDoCodigo, zerarLimite } from "@/modules/identidade/limite";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "10.7.7.7" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Error(`REDIRECT ${destino}`);
  },
}));

// Corrida: um palpite ERRADO está em andamento (a biblioteca já consumiu a linha do código) quando
// ocorre um reenvio; ao falhar, a biblioteca regrava o código ANTIGO. Só o código mais recente de
// um endereço pode valer. A ordem do defeito é imposta por um ponto de espera injetado só aqui:
// a regravação da biblioteca espera o reenvio terminar.

const criados: string[] = [];
const novo = (p: string) => {
  const e = `${p}-${randomBytes(5).toString("hex")}@convite.example`;
  criados.push(e);
  return e;
};

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  process.env.MAIL_TRANSPORT = "arquivo";
  process.env.MAIL_DIR = mkdtempSync(join(tmpdir(), "jnf-reenvio-"));
  process.env.APP_URL = "http://localhost:3999";
});

afterAll(async () => {
  const db = obterDb();
  for (const e of criados) {
    await zerarLimite(chaveFalhasDoCodigo(e));
    await db.delete(verificacao).where(eq(verificacao.identifier, `sign-in-otp-${e}`));
  }
  const donos = await db
    .select({ id: usuario.id })
    .from(usuario)
    .where(inArray(usuario.email, criados));
  if (donos.length)
    await db.delete(sessao).where(
      inArray(
        sessao.userId,
        donos.map((d) => d.id),
      ),
    );
  await db.delete(convite).where(inArray(convite.emailNorm, criados));
  await db.delete(usuario).where(inArray(usuario.email, criados));
  await obterPool().end();
});

const form = (email: string, codigo: string) => {
  const f = new FormData();
  f.set("email", email);
  f.set("codigo", codigo);
  return f;
};
const erradoPara = (certo: string) => (certo === "000000" ? "000001" : "000000");

async function emitir(email: string): Promise<string> {
  const { obterAuth } = await import("@/lib/auth");
  await apagarCodigoDe(email); // o que o envio de produção faz antes de criar
  return (await obterAuth().api.createVerificationOTP({
    body: { email, type: "sign-in" },
  })) as string;
}

async function entrar(email: string, codigo: string): Promise<string> {
  const { entrarComCodigo } = await import("@/modules/identidade/entrada");
  try {
    const r = await entrarComCodigo({ codigoDigitado: "" } as never, form(email, codigo));
    return r.resultado ?? "ok";
  } catch (e) {
    return (e as Error).message.startsWith("REDIRECT") ? "entrou" : `erro:${(e as Error).message}`;
  }
}

describe("reenvio durante um palpite errado", () => {
  it("o código NOVO entra e o antigo é recusado", async () => {
    const email = novo("corrida");
    await convidar(email, null, { enviar: false });
    const antigo = await emitir(email);

    const { obterAuth } = await import("@/lib/auth");
    const contexto = await obterAuth().$context;
    const adaptador = contexto.internalAdapter;
    const criar = adaptador.createVerificationValue.bind(adaptador);
    let novoCodigo = "";
    let disparou = false;
    adaptador.createVerificationValue = (async (dados: { value: string }) => {
      // A regravação do palpite que falhou ("<código>:1") espera o reenvio inteiro terminar.
      if (!disparou && dados.value.endsWith(":1")) {
        disparou = true;
        novoCodigo = await emitir(email);
      }
      return criar(dados as never);
    }) as typeof adaptador.createVerificationValue;

    try {
      const palpite = await entrar(email, erradoPara(antigo));
      expect(palpite).toBe("codigo-invalido");
    } finally {
      adaptador.createVerificationValue = criar;
    }
    // Controle: a corrida aconteceu (houve reenvio no meio do palpite) e os códigos diferem.
    expect(disparou).toBe(true);
    expect(novoCodigo).not.toBe(antigo);

    expect(await entrar(email, antigo)).toBe("codigo-invalido");
    expect(await entrar(email, novoCodigo)).toBe("entrou");
  });

  it("controle: sem corrida, palpite errado e depois o código certo entram normalmente", async () => {
    const email = novo("normal");
    await convidar(email, null, { enviar: false });
    const codigo = await emitir(email);
    expect(await entrar(email, erradoPara(codigo))).toBe("codigo-invalido");
    expect(await entrar(email, codigo)).toBe("entrou");
  });
});
