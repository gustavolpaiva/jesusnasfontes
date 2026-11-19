import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { sessao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { conferirCodigo } from "@/modules/identidade/conferencia";
import { chaveDaCriacaoDoSegundoFator, zerarLimite } from "@/modules/identidade/limite";
import {
  concederSegundoFator,
  desfazerAtivacao,
  estadoDoCadastro,
  sessaoVerificada,
} from "@/modules/identidade/sessao-mfa";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

const cena = vi.hoisted(() => ({ cabecalhos: undefined as Headers | undefined }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => cena.cabecalhos }));

// Concessão e compensação do segundo fator são serializadas por conta (trava da linha de geração).
// Estas provas usam um ponto de espera que só existe em teste, entre a leitura e a escrita da
// compensação, sob a trava.

const segredoDaBiblioteca = randomBytes(32).toString("hex");
const assinado = (v: string) =>
  encodeURIComponent(
    `${v}.${createHmac("sha256", segredoDaBiblioteca).update(v).digest("base64")}`,
  );
const contasCriadas: string[] = [];

async function criarSessao(userId: string) {
  const sessaoId = randomUUID();
  const token = randomBytes(24).toString("hex");
  await obterDb()
    .insert(sessao)
    .values({ id: sessaoId, userId, token, expiresAt: new Date(Date.now() + 3_600_000) });
  return {
    sessaoId,
    cabecalhos: new Headers({ cookie: `better-auth.session_token=${assinado(token)}` }),
  };
}

async function criarAdmin() {
  const id = randomUUID();
  await obterDb()
    .insert(usuario)
    .values({ id, email: `cmp-${randomBytes(4).toString("hex")}@example.test`, role: "admin" });
  contasCriadas.push(id);
  return { id, ...(await criarSessao(id)) };
}

// O que a biblioteca faz ao ativar (as duas escritas dela, sobre uma linha pendente real).
async function ativarComoABiblioteca(userId: string) {
  await obterDb().execute(
    sql`update auth.two_factor set verified = true where user_id = ${userId}`,
  );
  await obterDb().execute(
    sql`update auth."user" set two_factor_enabled = true where id = ${userId}`,
  );
}

async function pendente() {
  const { obterAuth } = await import("@/lib/auth");
  const a = await criarAdmin();
  await obterAuth().api.enableTwoFactor({ body: {}, headers: a.cabecalhos });
  // A linha de geração já existe (como em produção depois da primeira conferência): a serialização
  // vem da trava de linha, não da criação da linha.
  await obterDb().execute(
    sql`insert into admin.segundo_fator_geracao (user_id, geracao) values (${a.id}, 0) on conflict do nothing`,
  );
  return a;
}

const foto = async (id: string) => ({
  ativo: (await obterDb().select().from(usuario).where(eq(usuario.id, id)))[0]?.twoFactorEnabled,
  cadastro: await estadoDoCadastro(id),
});

// Espera estado do BANCO (não tempo): a concessão terminou, ou está parada na trava de linha.
async function ate(condicao: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) if (await condicao()) return;
  throw new Error("condição não ocorreu");
}
const bloqueadoNaTrava = async () =>
  (
    await obterDb().execute(sql`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%segundo_fator_geracao%' limit 1`)
  ).rows.length > 0;

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = segredoDaBiblioteca;
  process.env.APP_URL = "http://localhost:3999";
});
afterAll(async () => {
  for (const id of contasCriadas) await zerarLimite(chaveDaCriacaoDoSegundoFator(id));
  if (contasCriadas.length > 0) {
    await obterDb().delete(usuario).where(inArray(usuario.id, contasCriadas));
  }
  await obterPool().end();
});

describe("concessão e compensação concorrentes (recusada lê, válida concede, recusada compensa)", () => {
  it("a compensação lê, a concessão tenta no meio: o estado final é coerente (nunca pendente com sessão verificada)", async () => {
    const a = await pendente();
    await ativarComoABiblioteca(a.id); // a válida: a biblioteca já ativou
    let concessao: Promise<boolean> | undefined;
    let terminou = false;
    await desfazerAtivacao(a.id, async () => {
      // Aqui a compensação já leu "nenhuma sessão verificada" e ainda não escreveu.
      concessao = concederSegundoFator(a.id, a.sessaoId, 0).finally(() => {
        terminou = true;
      });
      await ate(async () => terminou || (await bloqueadoNaTrava()));
    });
    expect(await concessao).toBeTypeOf("boolean");
    const verificada = await sessaoVerificada(a.sessaoId);
    const estado = await foto(a.id);
    // Ou o fator está ativo e a sessão da válida verificada, ou está pendente e nada foi concedido.
    if (verificada) expect(estado).toEqual({ ativo: true, cadastro: "ativo" });
    else expect(estado).toEqual({ ativo: false, cadastro: "pendente" });
  });

  it("a concessão primeiro: a compensação posterior não devolve o fator a pendente", async () => {
    const a = await pendente();
    await ativarComoABiblioteca(a.id);
    expect(await concederSegundoFator(a.id, a.sessaoId, 0)).toBe(true);
    await desfazerAtivacao(a.id);
    expect(await foto(a.id)).toEqual({ ativo: true, cadastro: "ativo" });
    expect(await sessaoVerificada(a.sessaoId)).toBe(true);
  });

  it("a compensação primeiro: a concessão seguinte não concede sobre fator devolvido a pendente (controle)", async () => {
    const a = await pendente();
    await ativarComoABiblioteca(a.id);
    await desfazerAtivacao(a.id);
    expect(await concederSegundoFator(a.id, a.sessaoId, 0)).toBe(false);
    expect(await sessaoVerificada(a.sessaoId)).toBe(false);
    expect(await foto(a.id)).toEqual({ ativo: false, cadastro: "pendente" });
  });
});

describe("depois de ATIVO, só a recuperação do dono devolve o fator a pendente", () => {
  it("nenhum caminho de compensação ou de cadastro, com sessão só de primeiro fator, o desfaz nem mostra o segredo", async () => {
    const { prepararCadastro } = await import("@/modules/identidade/segundo-fator-cadastro");
    const a = await criarAdmin();
    // Controle positivo: antes da primeira concessão o cadastro mostra o segredo.
    cena.cabecalhos = a.cabecalhos;
    const antes = await prepararCadastro(a.id);
    expect(antes?.chave.length).toBeGreaterThan(20);

    await ativarComoABiblioteca(a.id);
    expect(await concederSegundoFator(a.id, a.sessaoId, 0)).toBe(true);
    const ativo = { ativo: true, cadastro: "ativo" };

    // Caminhos de compensação.
    await desfazerAtivacao(a.id);
    expect(await foto(a.id)).toEqual(ativo);
    const apiRecusa = {
      verifyTOTP: async () => {
        throw Object.assign(new Error("INVALID_CODE"), { name: "APIError" });
      },
      verifyBackupCode: async () => undefined,
      viewBackupCodes: async () => ({ backupCodes: [] }),
    };
    const base = {
      alvo: "aplicativo" as const,
      usuarioId: a.id,
      sessaoAtualId: a.sessaoId,
      geracao: 0,
      estado: "pendente" as const, // retrato velho: a conferência começou antes de o fator ativar
      cabecalhos: a.cabecalhos,
      sessaoQueVale: async (id: string) => id,
    };
    const r1 = await conferirCodigo({ ...base, api: apiRecusa as never, codigo: "000001" });
    expect(r1.tipo).toBe("recusado");
    await expect(
      conferirCodigo({
        ...base,
        codigo: "000002",
        api: {
          ...apiRecusa,
          verifyTOTP: async () => {
            await obterDb().execute(sql`select 1/0`);
          },
        } as never,
      }),
    ).rejects.toMatchObject({ code: "22012" });
    await expect(
      conferirCodigo({
        ...base,
        codigo: "000003",
        api: { ...apiRecusa, verifyTOTP: async () => undefined } as never,
        conceder: async () => {
          await obterDb().execute(sql`select 1/0`);
          return true;
        },
      }),
    ).rejects.toMatchObject({ code: "22012" });
    expect(await foto(a.id)).toEqual(ativo);

    // Caminho de cadastro: uma NOVA sessão só de primeiro fator não recebe segredo nem códigos.
    const outra = await criarSessao(a.id);
    cena.cabecalhos = outra.cabecalhos;
    expect(await prepararCadastro(a.id)).toBeNull();
    expect(await sessaoVerificada(outra.sessaoId)).toBe(false);
    expect(await foto(a.id)).toEqual(ativo);
  });
});
