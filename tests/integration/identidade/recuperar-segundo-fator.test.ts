import { randomBytes, randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { doisFatores, sessao, sessaoMfa } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import {
  chaveDaCriacaoDoSegundoFator,
  chaveSegundoFatorDaConta,
  consumirLimite,
} from "@/modules/identidade/limite";
import {
  recuperarSegundoFator,
  TETO_DE_SESSOES,
} from "../../../scripts/admin/recuperar-segundo-fator";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

vi.mock("server-only", () => ({}));

// Recuperação do segundo fator: prévia somente leitura e escrita só pelo id conferido. Cada negativo
// tem o controle positivo (a recuperação certa funciona) e a prova de que OUTRA conta não é tocada.

const contasCriadas: string[] = [];

type Conta = { id: string; email: string };

async function criarConta(papel: "admin" | "estudante", sessoes = 2): Promise<Conta> {
  const id = randomUUID();
  const email = `rec-${randomBytes(4).toString("hex")}@example.test`;
  const db = obterDb();
  await db.insert(usuario).values({ id, email, role: papel, twoFactorEnabled: true });
  contasCriadas.push(id);
  await db
    .insert(doisFatores)
    .values({ secret: "segredo-cifrado", backupCodes: "codigos", userId: id });
  const ids: string[] = [];
  for (let i = 0; i < sessoes; i++) {
    const sid = randomUUID();
    ids.push(sid);
    await db.insert(sessao).values({
      id: sid,
      userId: id,
      token: randomBytes(24).toString("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }
  if (ids[0]) await db.insert(sessaoMfa).values({ sessionId: ids[0] });
  await consumirLimite(chaveSegundoFatorDaConta(id), 10, 3600);
  await consumirLimite(chaveDaCriacaoDoSegundoFator(id), 1, 3600);
  return { id, email };
}

// Foto de tudo o que a recuperação pode tocar, para UMA conta.
async function foto(id: string) {
  const r = await obterDb().execute<Record<string, unknown>>(sql`
    select
      (select two_factor_enabled from auth."user" where id = ${id}) as ativo,
      (select count(*) from auth.two_factor where user_id = ${id})::int as fatores,
      (select count(*) from auth.session where user_id = ${id})::int as sessoes,
      (select count(*) from admin.sessao_mfa m join auth.session s on s.id = m.session_id where s.user_id = ${id})::int as marcas,
      (select count(*) from admin.tentativa where chave in (${chaveSegundoFatorDaConta(id)}, ${chaveDaCriacaoDoSegundoFator(id)}))::int as limites,
      (select count(*) from admin.segundo_fator_geracao where user_id = ${id} and geracao > 0)::int as geracoes`);
  return r.rows[0];
}

beforeAll(() => {
  aplicarEnvDeTeste();
});
afterAll(async () => {
  if (contasCriadas.length > 0) {
    await obterDb().execute(
      sql`delete from admin.tentativa where chave in (${sql.join(
        contasCriadas
          .flatMap((c) => [chaveSegundoFatorDaConta(c), chaveDaCriacaoDoSegundoFator(c)])
          .map((k) => sql`${k}`),
        sql`, `,
      )})`,
    );
    await obterDb().delete(usuario).where(inArray(usuario.id, contasCriadas));
  }
  await obterPool().end();
});

describe("prévia (padrão): somente leitura", () => {
  it("mostra o id e as contagens e não escreve nada", async () => {
    const alvo = await criarConta("admin", 3);
    const outra = await criarConta("admin");
    const antes = [await foto(alvo.id), await foto(outra.id)];
    const r = await recuperarSegundoFator(alvo.email);
    expect(r.codigo).toBe(0);
    expect(r.mensagem).toContain(`id: ${alvo.id}`);
    expect(r.mensagem).toContain("papel: admin");
    expect(r.mensagem).toContain("sessões 3");
    expect(r.mensagem).toContain("linhas de segundo fator 1");
    expect(r.mensagem).toContain("linhas de limite 2");
    expect(r.mensagem).not.toContain(alvo.email);
    expect([await foto(alvo.id), await foto(outra.id)]).toEqual(antes);
    expect((antes[0] as { sessoes: number }).sessoes).toBe(3); // controle: havia o que apagar
  });

  it("a transação da prévia é somente leitura de fato (o banco recusa escrita nela)", async () => {
    await expect(
      obterDb().transaction(
        async (tx) => {
          await tx.execute(sql`update auth."user" set name = name where false`);
        },
        { accessMode: "read only" },
      ),
    ).rejects.toMatchObject({ code: "25006" });
  });

  it("endereço sem conta: 2 e nada muda (controle negativo)", async () => {
    const a = await criarConta("admin");
    const antes = await foto(a.id);
    const r = await recuperarSegundoFator("ninguem-aqui@example.test", {
      executar: true,
      id: a.id,
    });
    expect(r.codigo).toBe(2);
    expect(r.mensagem).toContain("ContaInexistente");
    expect(await foto(a.id)).toEqual(antes);
  });
});

describe("escrita: só com --executar e o id conferido", () => {
  it("--executar sem --id é recusado e nada muda", async () => {
    const a = await criarConta("admin");
    const antes = await foto(a.id);
    const r = await recuperarSegundoFator(a.email, { executar: true });
    expect(r.codigo).toBe(2);
    expect(r.mensagem).toContain("IdObrigatorio");
    expect(await foto(a.id)).toEqual(antes);
  });

  it("id de OUTRA conta ou inventado: recusado e nenhuma das duas muda", async () => {
    const a = await criarConta("admin");
    const b = await criarConta("admin");
    const antes = [await foto(a.id), await foto(b.id)];
    for (const id of [b.id, randomUUID(), "nao-e-uuid"]) {
      const r = await recuperarSegundoFator(a.email, { executar: true, id });
      expect(r.codigo).toBe(2);
    }
    expect([await foto(a.id), await foto(b.id)]).toEqual(antes);
  });

  it("conta que não é Admin é recusada, na prévia e na escrita", async () => {
    const e = await criarConta("estudante");
    const antes = await foto(e.id);
    expect((await recuperarSegundoFator(e.email)).mensagem).toContain("ContaNaoAdmin");
    const r = await recuperarSegundoFator(e.email, { executar: true, id: e.id });
    expect(r.codigo).toBe(2);
    expect(await foto(e.id)).toEqual(antes);
  });

  it("teto de sessões: acima dele aborta antes de apagar; no teto passa (controle)", async () => {
    const cheia = await criarConta("admin", TETO_DE_SESSOES + 1);
    const antes = await foto(cheia.id);
    const r = await recuperarSegundoFator(cheia.email, { executar: true, id: cheia.id });
    expect(r.codigo).toBe(2);
    expect(r.mensagem).toContain("TetoExcedido");
    expect(await foto(cheia.id)).toEqual(antes);

    const noTeto = await criarConta("admin", TETO_DE_SESSOES);
    const ok = await recuperarSegundoFator(noTeto.email, { executar: true, id: noTeto.id });
    expect(ok.codigo).toBe(0);
    expect((await foto(noTeto.id))?.sessoes).toBe(0);
  });

  it("duas contas com segundo fator, sessões e limites: só a alvo perde; a OUTRA fica inteira", async () => {
    const alvo = await criarConta("admin", 3);
    const outra = await criarConta("admin", 2);
    const fotoOutra = await foto(outra.id);
    expect(fotoOutra).toMatchObject({ ativo: true, fatores: 1, sessoes: 2, marcas: 1, limites: 2 });

    const previa = await recuperarSegundoFator(alvo.email);
    expect(previa.codigo).toBe(0);
    const r = await recuperarSegundoFator(alvo.email, { executar: true, id: alvo.id });
    expect(r.codigo).toBe(0);
    expect(r.mensagem).toContain("linhas: 1");
    expect(r.mensagem).toContain("sessões encerradas: 3");
    expect(r.mensagem).toContain("linhas de limite: 2");
    expect(r.mensagem).not.toContain(alvo.email);

    expect(await foto(alvo.id)).toMatchObject({
      ativo: false,
      fatores: 0,
      sessoes: 0,
      marcas: 0,
      limites: 0,
      geracoes: 1,
    });
    expect(await foto(outra.id)).toEqual(fotoOutra);
  });
});
