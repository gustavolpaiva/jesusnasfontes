import { createHash, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { geracaoSegundoFator, sessao, sessaoMfa, verificacao } from "@/db/schema/entrada";
import { usuario } from "@/db/schema/fundacao";
import { urlDoPapel } from "@/db/url";
import { registrarPosicao } from "@/modules/trilhas/posicao";
import {
  conferirAmbienteDev,
  divergencias,
  formatar,
  medirEntrada,
  medirTotais,
  NaoMedido,
} from "../../../scripts/dev/conferir-entrada";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// O conferidor da entrada real só LÊ e só imprime contagens. Aqui o estado que a Tarefa 3 deve deixar
// é montado no banco descartável, e cada divergência tem ao lado o caso em que tudo confere.

const emNeon = () => inject("alvoBanco") === "neon";
const rodada = randomUUID();
const trilha = `teste-ce-${rodada.slice(0, 8)}`;
const estudo = randomUUID();
const HASH = createHash("sha256").update(rodada).digest("hex");
const ids: string[] = [];

function conta(nome: string) {
  const id = randomUUID();
  ids.push(id);
  return { id, email: `${nome}-${id.slice(0, 8)}-${rodada}@example.test` };
}

async function comoCarga<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function comoDono<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function medir(p: { desde: Date; emailAdmin: string; emailEstudante: string }) {
  const c = await obterPool().connect();
  try {
    await c.query("begin read only");
    try {
      return await medirEntrada(c, p);
    } finally {
      await c.query("rollback");
    }
  } finally {
    c.release();
  }
}

async function montar(opcoes: { posicaoDoEstudante?: boolean; sobraDeLink?: boolean } = {}) {
  const admin = conta("admin");
  const estudante = conta("estudante");
  await obterDb()
    .insert(usuario)
    .values([
      { id: admin.id, email: admin.email, role: "admin" },
      { id: estudante.id, email: estudante.email },
    ]);
  const expira = new Date(Date.now() + 3_600_000);
  const sa = randomUUID();
  const se = randomUUID();
  await obterDb()
    .insert(sessao)
    .values([
      { id: sa, userId: admin.id, token: `t-${randomUUID()}`, expiresAt: expira },
      { id: se, userId: estudante.id, token: `t-${randomUUID()}`, expiresAt: expira },
    ]);
  await obterDb().insert(sessaoMfa).values({ sessionId: sa });
  await obterDb().insert(geracaoSegundoFator).values({ userId: admin.id, concedidoEm: new Date() });
  await registrarPosicao(admin.id, { trilhaId: trilha, estudoId: estudo });
  if (opcoes.posicaoDoEstudante) {
    await registrarPosicao(estudante.id, { trilhaId: trilha, estudoId: estudo });
  }
  if (opcoes.sobraDeLink) {
    await obterDb()
      .insert(verificacao)
      .values({
        identifier: `sign-in-otp-${estudante.email}`,
        value: "hash",
        expiresAt: expira,
      });
  }
  return { admin, estudante };
}

const umMinutoAtras = () => new Date(Date.now() - 60_000);

beforeAll(async () => {
  aplicarEnvDeTeste();
  if (emNeon()) return;
  await comoCarga(async (c) => {
    await c.query(
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, $3, 'x')",
      [trilha, `Trilha ${rodada}`, 26_000 + Math.floor(Math.random() * 5_000)],
    );
    await c.query(
      `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
       values ($1, $2, $3, 1, 'x', 'devocional', 'x', $4)`,
      [estudo, `teste-ce-${rodada}`, trilha, HASH],
    );
  });
});

afterAll(async () => {
  if (!emNeon()) {
    await obterDb().delete(usuario).where(inArray(usuario.id, ids));
    await comoDono(async (c) => {
      await c.query("delete from conteudo.estudo where id = $1", [estudo]);
      await c.query("delete from conteudo.trilha where id = $1", [trilha]);
    });
  }
  await obterPool().end();
});

describe.skipIf(emNeon())("conferir-entrada: só contagens, só leitura", () => {
  it("o estado que a entrada real deixa confere (exit 0), com as contagens esperadas", async () => {
    const { admin, estudante } = await montar();
    const m = await medir({
      desde: umMinutoAtras(),
      emailAdmin: admin.email,
      emailEstudante: estudante.email,
    });
    expect(m.admin).toMatchObject({
      existe: true,
      sessoesNovas: 1,
      sessoesComSegundoFator: 1,
      segundoFatorConcedido: true,
      posicoes: 1,
      verificacoesRestantes: 0,
    });
    expect(m.estudante).toMatchObject({ sessoesNovas: 1, posicoes: 0, verificacoesRestantes: 0 });
    expect(divergencias(m)).toEqual([]);
  });

  it("a saída tem só chaves e números: nenhum endereço, id ou código", async () => {
    const { admin, estudante } = await montar();
    const m = await medir({
      desde: umMinutoAtras(),
      emailAdmin: admin.email,
      emailEstudante: estudante.email,
    });
    const saida = formatar(m).join("\n");
    expect(saida).not.toContain(admin.email);
    expect(saida).not.toContain(estudante.email);
    expect(saida).not.toContain(admin.id);
    expect(saida).not.toContain(rodada);
    for (const linha of saida.split("\n")) {
      expect(linha).toMatch(/^(admin|estudante)\.[a-z_]+=(\d+|true|false|tabela_ausente)$/);
    }
  });

  it("instante no futuro: nenhuma sessão é nova, e cada divergência é nomeada", async () => {
    const { admin, estudante } = await montar();
    const m = await medir({
      desde: new Date(Date.now() + 3_600_000),
      emailAdmin: admin.email,
      emailEstudante: estudante.email,
    });
    expect(divergencias(m)).toEqual([
      "admin.sessoes_novas>=1",
      "estudante.sessoes_novas>=1",
      "admin.sessoes_com_segundo_fator>=1",
    ]);
  });

  it("canário com posição de leitura e verificação que sobrou: diverge", async () => {
    const { admin, estudante } = await montar({ posicaoDoEstudante: true, sobraDeLink: true });
    const m = await medir({
      desde: umMinutoAtras(),
      emailAdmin: admin.email,
      emailEstudante: estudante.email,
    });
    expect(divergencias(m)).toEqual(["estudante.posicoes=0", "estudante.verificacoes_restantes=0"]);
  });

  it("conta que não existe: diverge, sem erro", async () => {
    const m = await medir({
      desde: umMinutoAtras(),
      emailAdmin: `ninguem-${rodada}@example.test`,
      emailEstudante: `ninguem2-${rodada}@example.test`,
    });
    expect(divergencias(m)).toContain("admin.existe");
    expect(divergencias(m)).toContain("estudante.existe");
  });

  it("não escreve nada: a transação somente leitura recusa uma escrita", async () => {
    const c = await obterPool().connect();
    try {
      await c.query("begin read only");
      const erro = await c.query("delete from auth.verification").catch((e: unknown) => e);
      await c.query("rollback");
      expect((erro as { code?: string }).code).toBe("25006");
    } finally {
      c.release();
    }
  });

  it("recusa banco que não é o de dev (marcador 'producao') antes de medir qualquer coisa", async () => {
    const falso = { query: async () => ({ rows: [{ nome: "producao" }] }) };
    await expect(conferirAmbienteDev(falso as never)).rejects.toBeInstanceOf(NaoMedido);
    const dev = { query: async () => ({ rows: [{ nome: "dev" }] }) };
    await expect(conferirAmbienteDev(dev as never)).resolves.toBeUndefined();
  });

  it("totais: incluem as contas montadas, e a posição soma conta por conta sob a RLS", async () => {
    // Outros arquivos de teste criam e apagam contas no mesmo banco ao mesmo tempo: a diferença entre
    // duas leituras não é estável. O que vale sempre é o piso: as nossas linhas existem até o fim.
    await montar();
    const t = await comTransacao((c) => medirTotais(c));
    expect(t.usuarios).toBeGreaterThanOrEqual(2);
    expect(t.sessoes).toBeGreaterThanOrEqual(2);
    expect(t.posicoes ?? 0).toBeGreaterThanOrEqual(1);
  });
});

async function comTransacao<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await obterPool().connect();
  try {
    await c.query("begin read only");
    try {
      return await fn(c);
    } finally {
      await c.query("rollback");
    }
  } finally {
    c.release();
  }
}
