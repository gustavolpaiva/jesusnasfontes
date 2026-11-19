import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { sessao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { urlDoPapel } from "@/db/url";
import { conferirCodigo } from "@/modules/identidade/conferencia";
import { zerarLimite } from "@/modules/identidade/limite";
import {
  concederSegundoFator,
  estadoDoCadastro,
  geracaoDoSegundoFator,
  LIMITE_POR_CONTA,
  reivindicarCodigoDeAplicativo,
  reservarTentativaDaConta,
  reservarTentativaDaSessao,
  sessaoVerificada,
  TENTATIVAS_POR_SESSAO,
} from "@/modules/identidade/sessao-mfa";
import { recuperarSegundoFator } from "../../../scripts/admin/recuperar-segundo-fator";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";
import { decodificarBase32 } from "../../support/totp";

vi.mock("server-only", () => ({}));

// Segundo fator do Admin contra o Postgres: reservas atômicas, onde o segredo mora e quem o lê, e
// que nenhum caminho de verificação deixa segredo ou código em registro. Cada afirmação negativa
// tem o controle positivo ao lado.

const segredoDaBiblioteca = randomBytes(32).toString("hex");
const assinado = (v: string) =>
  encodeURIComponent(
    `${v}.${createHmac("sha256", segredoDaBiblioteca).update(v).digest("base64")}`,
  );

const contasCriadas: string[] = [];
const chavesLimite: string[] = [];

async function criarAdminComSessao() {
  const id = randomUUID();
  const email = `adm-${randomBytes(4).toString("hex")}@example.test`;
  await obterDb().insert(usuario).values({ id, email, role: "admin" });
  contasCriadas.push(id);
  const sessaoId = randomUUID();
  const token = randomBytes(24).toString("hex");
  await obterDb()
    .insert(sessao)
    .values({ id: sessaoId, userId: id, token, expiresAt: new Date(Date.now() + 3_600_000) });
  const cabecalhos = new Headers({ cookie: `better-auth.session_token=${assinado(token)}` });
  return { id, sessaoId, token, cabecalhos };
}

beforeAll(() => {
  aplicarEnvDeTeste();
  process.env.BETTER_AUTH_SECRET = segredoDaBiblioteca;
  process.env.APP_URL = "http://localhost:3999";
});
afterAll(async () => {
  for (const c of chavesLimite) await zerarLimite(c);
  if (contasCriadas.length > 0) {
    await obterDb().delete(usuario).where(inArray(usuario.id, contasCriadas));
  }
  await obterPool().end();
});

describe("reservas atômicas (a tentativa é gasta antes de comparar)", () => {
  it("12 tentativas simultâneas na mesma sessão: contagens distintas e só 5 passam", async () => {
    const { sessaoId } = await criarAdminComSessao();
    const r = await Promise.all(
      Array.from({ length: 12 }, () => reservarTentativaDaSessao(sessaoId)),
    );
    expect(new Set(r.map((x) => x.usadas)).size).toBe(12);
    expect(r.filter((x) => x.concedida)).toHaveLength(TENTATIVAS_POR_SESSAO);
  });

  it("controle: uma sessão não consome a tentativa de outra", async () => {
    const a = await criarAdminComSessao();
    const b = await criarAdminComSessao();
    await Promise.all(Array.from({ length: 8 }, () => reservarTentativaDaSessao(a.sessaoId)));
    expect((await reservarTentativaDaSessao(b.sessaoId)).concedida).toBe(true);
  });

  it("15 tentativas simultâneas na mesma conta: só o teto passa", async () => {
    const { id } = await criarAdminComSessao();
    const { chaveSegundoFatorDaConta } = await import("@/modules/identidade/limite");
    chavesLimite.push(chaveSegundoFatorDaConta(id));
    const r = await Promise.all(Array.from({ length: 15 }, () => reservarTentativaDaConta(id)));
    expect(r.filter(Boolean)).toHaveLength(LIMITE_POR_CONTA.maximo);
  });

  it("o mesmo código de aplicativo, 10 vezes ao mesmo tempo: uma só vence; outro código vale", async () => {
    const { id } = await criarAdminComSessao();
    const { chaveDe } = await import("@/modules/identidade/limite");
    chavesLimite.push(chaveDe("totp-usado", `${id}:123456`), chaveDe("totp-usado", `${id}:654321`));
    const r = await Promise.all(
      Array.from({ length: 10 }, () => reivindicarCodigoDeAplicativo(id, "123456")),
    );
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await reivindicarCodigoDeAplicativo(id, "654321")).toBe(true);
  });
});

describe("onde o segredo mora e quem o lê", () => {
  it("jnf_assistente não lê nada de auth; jnf_app só vê o segredo cifrado, que só abre com a chave certa", async () => {
    const { obterAuth } = await import("@/lib/auth");
    const a = await criarAdminComSessao();
    const b = await criarAdminComSessao();
    const criar = async (c: typeof a) =>
      (await obterAuth().api.enableTwoFactor({ body: {}, headers: c.cabecalhos })) as {
        totpURI: string;
        backupCodes: string[];
      };
    const ea = await criar(a);
    await criar(b);
    const segredoEmClaro = new URL(ea.totpURI).searchParams.get("secret") as string;
    expect(segredoEmClaro.length).toBeGreaterThan(20);

    // jnf_app (o papel do site) lê a linha da OUTRA conta, e o que vem é cifrado: nem o segredo em
    // claro nem os códigos de recuperação aparecem.
    const comoApp = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: true }) });
    await comoApp.connect();
    let linhaA: { secret: string; backup_codes: string };
    try {
      const r = await comoApp.query<{ secret: string; backup_codes: string }>(
        "select secret, backup_codes from auth.two_factor where user_id = $1",
        [a.id],
      );
      linhaA = r.rows[0] as { secret: string; backup_codes: string };
    } finally {
      await comoApp.end();
    }
    expect(linhaA.secret).toBeTruthy(); // controle: a linha existe e foi lida
    expect(linhaA.secret).not.toContain(segredoEmClaro);
    expect(linhaA.secret).not.toMatch(/^[A-Z2-7]{20,}$/);
    for (const codigo of ea.backupCodes) expect(linhaA.backup_codes).not.toContain(codigo);

    // Controle positivo: com a chave certa o segredo abre e é o mesmo; com outra, não.
    const { symmetricDecrypt } = await import("better-auth/crypto");
    const contexto = await obterAuth().$context;
    const bruto = await symmetricDecrypt({ key: contexto.secretConfig, data: linhaA.secret });
    expect(decodificarBase32(segredoEmClaro).toString()).toBe(bruto);
    expect(linhaA.secret).not.toContain(bruto);
    await expect(
      symmetricDecrypt({ key: randomBytes(32).toString("hex"), data: linhaA.secret }),
    ).rejects.toThrow();

    // jnf_assistente: nem o esquema auth ele alcança.
    const comoAssistente = new pg.Client({
      connectionString: urlDoPapel("assistente", { agrupada: true }),
    });
    await comoAssistente.connect();
    try {
      const positivo = await comoAssistente.query("select 1 as n from acervo.ambiente limit 1");
      expect(positivo.rowCount).toBeGreaterThanOrEqual(0); // conectou e consulta o que lhe cabe
      await expect(
        comoAssistente.query("select secret from auth.two_factor"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        comoAssistente.query("select backup_codes from auth.two_factor"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await comoAssistente.end();
    }
  });

  it("uma linha de segundo fator por conta: a segunda criação falha no banco", async () => {
    const { obterAuth } = await import("@/lib/auth");
    const a = await criarAdminComSessao();
    await obterAuth().api.enableTwoFactor({ body: {}, headers: a.cabecalhos });
    const dono = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
    await dono.connect();
    try {
      await expect(
        dono.query(
          "insert into auth.two_factor (secret, backup_codes, user_id) values ('x', 'y', $1)",
          [a.id],
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await dono.end();
    }
  });
});

describe("ativação que retoma depois de uma recuperação (corrida entre dois fluxos)", () => {
  // Ordem do defeito, sem espera artificial: a conferência lê a geração e a biblioteca valida o
  // código; a recuperação termina; a conferência retoma e a biblioteca grava o que ficou para trás
  // (conta "ativa" e uma sessão nova). Daí a concessão tenta marcar a sessão.
  async function ativacaoPausada() {
    const { obterAuth } = await import("@/lib/auth");
    const a = await criarAdminComSessao();
    const email = (await obterDb().select().from(usuario).where(eq(usuario.id, a.id)))[0]
      ?.email as string;
    await obterAuth().api.enableTwoFactor({ body: {}, headers: a.cabecalhos });
    const geracaoLida = await geracaoDoSegundoFator(a.id);
    // A biblioteca já validou o código (cadastro pendente existe); a recuperação do dono do banco termina.
    const r = await recuperarSegundoFator(email, { executar: true, id: a.id });
    expect(r.codigo).toBe(0);
    // A retomada: o que a biblioteca grava depois (usuário ativo, sessão nova), sem linha de fator.
    const sessaoTardia = randomUUID();
    await obterDb()
      .insert(sessao)
      .values({
        id: sessaoTardia,
        userId: a.id,
        token: randomBytes(24).toString("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    await obterDb().update(usuario).set({ twoFactorEnabled: true }).where(eq(usuario.id, a.id));
    return { a, geracaoLida, sessaoTardia };
  }

  it("a conferência retomada não concede nada e a conta não fica 'ativa' sem segundo fator", async () => {
    const { a, geracaoLida, sessaoTardia } = await ativacaoPausada();
    expect(await geracaoDoSegundoFator(a.id)).toBe(geracaoLida + 1); // a recuperação passou
    expect(await concederSegundoFator(a.id, sessaoTardia, geracaoLida)).toBe(false);
    expect(await sessaoVerificada(sessaoTardia)).toBe(false);
    const [conta] = await obterDb().select().from(usuario).where(eq(usuario.id, a.id));
    expect(conta?.twoFactorEnabled).toBe(false);
  });

  it("uma marca de geração antiga não vale, mesmo que exista na tabela", async () => {
    const { a, geracaoLida, sessaoTardia } = await ativacaoPausada();
    await obterDb().execute(
      sql`insert into admin.sessao_mfa (session_id, geracao) values (${sessaoTardia}, ${geracaoLida})`,
    );
    expect(await sessaoVerificada(sessaoTardia)).toBe(false);
    // controle positivo: na geração atual, a concessão funciona e a sessão conta.
    const atual = await geracaoDoSegundoFator(a.id);
    expect(await concederSegundoFator(a.id, sessaoTardia, atual)).toBe(true);
    expect(await sessaoVerificada(sessaoTardia)).toBe(true);
  });
});

describe("a pessoa sai da ativação com fator ativo E códigos na mão, ou sem nada ativado", () => {
  // A biblioteca de teste não consegue criar a sessão nova fora do Next; o passo de ativar dela
  // (liga o usuário e marca a linha) é emulado por uma função com as duas escritas dela.
  async function preparar() {
    const { obterAuth } = await import("@/lib/auth");
    const a = await criarAdminComSessao();
    await obterAuth().api.enableTwoFactor({ body: {}, headers: a.cabecalhos });
    const real = obterAuth().api;
    const ativou: string[] = [];
    const ativarComoABiblioteca = async () => {
      ativou.push("sim");
      await obterDb().execute(
        sql`update auth.two_factor set verified = true where user_id = ${a.id}`,
      );
      await obterDb().execute(
        sql`update auth."user" set two_factor_enabled = true where id = ${a.id}`,
      );
    };
    const entrada = (api: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      api: api as never,
      alvo: "aplicativo" as const,
      codigo: "123456",
      usuarioId: a.id,
      sessaoAtualId: a.sessaoId,
      geracao: 0,
      estado: "pendente" as const,
      cabecalhos: a.cabecalhos,
      sessaoQueVale: async (id: string) => id,
      ...extra,
    });
    return { a, real, ativou, ativarComoABiblioteca, entrada };
  }
  const estadoDaConta = async (id: string) => ({
    ativo: (await obterDb().select().from(usuario).where(eq(usuario.id, id)))[0]?.twoFactorEnabled,
    cadastro: await estadoDoCadastro(id),
  });

  it("falha de banco na leitura dos códigos: nada ativado, sessão não verificada; repetir entrega os códigos", async () => {
    const { a, real, ativou, ativarComoABiblioteca, entrada } = await preparar();
    const falha = {
      viewBackupCodes: async () => {
        await obterDb().execute(sql`select 1/0`); // falha de banco de verdade (SQLSTATE 22012)
      },
      verifyTOTP: ativarComoABiblioteca,
      verifyBackupCode: async () => undefined,
    };
    await expect(conferirCodigo(entrada(falha))).rejects.toMatchObject({ code: "22012" });
    expect(ativou).toHaveLength(0);
    expect(await estadoDaConta(a.id)).toEqual({ ativo: false, cadastro: "pendente" });
    expect(await sessaoVerificada(a.sessaoId)).toBe(false);

    // Controle positivo: sem a falha, ativa e entrega os códigos, e a sessão passa a valer.
    const certo = {
      viewBackupCodes: real.viewBackupCodes,
      verifyTOTP: ativarComoABiblioteca,
      verifyBackupCode: async () => undefined,
    };
    const r = await conferirCodigo(entrada(certo, { codigo: "654321" }));
    expect(r).toMatchObject({ tipo: "concedido" });
    expect((r as { codigos: string[] }).codigos.length).toBeGreaterThan(0);
    expect(await estadoDaConta(a.id)).toEqual({ ativo: true, cadastro: "ativo" });
    expect(await sessaoVerificada(a.sessaoId)).toBe(true);
  });

  it("falha de banco depois de a biblioteca ativar e antes da concessão: a ativação é desfeita", async () => {
    const { a, real, ativarComoABiblioteca, entrada } = await preparar();
    const api = {
      viewBackupCodes: real.viewBackupCodes,
      verifyTOTP: ativarComoABiblioteca,
      verifyBackupCode: async () => undefined,
    };
    const conceder = async () => {
      await obterDb().execute(sql`select 1/0`);
      return true;
    };
    await expect(conferirCodigo(entrada(api, { conceder }))).rejects.toMatchObject({
      code: "22012",
    });
    expect(await estadoDaConta(a.id)).toEqual({ ativo: false, cadastro: "pendente" });
    expect(await sessaoVerificada(a.sessaoId)).toBe(false);
    // Nova tentativa do começo funciona e entrega os códigos.
    // (o código da tentativa que falhou já foi marcado como usado; a pessoa digita o do passo seguinte)
    const r = await conferirCodigo(entrada(api, { codigo: "246810" }));
    expect(r).toMatchObject({ tipo: "concedido" });
    expect((r as { codigos: string[] }).codigos.length).toBeGreaterThan(0);
  });

  it("desfazer nunca derruba um fator que uma sessão já verificou", async () => {
    const { a, ativarComoABiblioteca } = await preparar();
    await ativarComoABiblioteca();
    expect(await concederSegundoFator(a.id, a.sessaoId, 0)).toBe(true);
    const { desfazerAtivacao } = await import("@/modules/identidade/sessao-mfa");
    await desfazerAtivacao(a.id);
    expect(await estadoDaConta(a.id)).toEqual({ ativo: true, cadastro: "ativo" });
  });
});
