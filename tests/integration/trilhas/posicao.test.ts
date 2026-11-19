import { createHash, randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { criarCliente, obterDb, obterPool } from "@/db/cliente";
import { comEstudante, fabricarComEstudante } from "@/db/com-estudante";
import { usuario } from "@/db/schema/fundacao";
import { posicao } from "@/db/schema/posicao";
import { urlDoPapel } from "@/db/url";
import { lerUltimaPosicao, registrarPosicao } from "@/modules/trilhas/posicao";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Posição de leitura: dado privado do Estudante. Duas contas, dois Estudos, e cada "A não vê B" tem
// ao lado o controle positivo "A vê o que é dela". Os Estudos e Trilhas de teste são criados pelo
// papel de carga (o mesmo que a carga de conteúdo usa) e ficam fora das ordens reais.

const emNeon = () => inject("alvoBanco") === "neon";

const rodada = randomUUID();
const idA = randomUUID();
const idB = randomUUID();
const idC = randomUUID();
const trilhaX = `teste-pos-x-${rodada.slice(0, 8)}`;
const trilhaY = `teste-pos-y-${rodada.slice(0, 8)}`;
const estudoXA = randomUUID();
const estudoXB = randomUUID();
const estudoY = randomUUID();
const titulo = (nome: string) => `Título ${nome} ${rodada.slice(0, 8)}`;
const HASH = createHash("sha256").update(rodada).digest("hex");
const ordemBase = 20_000 + Math.floor(Math.random() * 5_000);

const codigoDe = (erro: unknown) =>
  (erro as { code?: string; cause?: { code?: string } }).code ??
  (erro as { cause?: { code?: string } }).cause?.code;

async function comoCarga<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

// Dono do banco descartável (superusuário local): ignora a RLS, e por isso serve de "contagem
// verdadeira" para conferir o que a conta, sob a RLS, não enxerga. Só existe no banco local.
async function comoDono<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

beforeAll(async () => {
  aplicarEnvDeTeste();
  if (emNeon()) return; // cria Trilhas e Estudos: só no banco descartável
  await comoCarga(async (c) => {
    await c.query(
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, $3, 'x'), ($4, $5, $6, 'x')",
      [trilhaX, `Trilha X ${rodada}`, ordemBase, trilhaY, `Trilha Y ${rodada}`, ordemBase + 1],
    );
    const estudos: [string, string, string, number][] = [
      [estudoXA, trilhaX, "xa", 1],
      [estudoXB, trilhaX, "xb", 2],
      [estudoY, trilhaY, "y", 1],
    ];
    for (const [id, trilha, nome, ordem] of estudos) {
      await c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, $4, $5, 'devocional', 'x', $6)`,
        [id, `teste-pos-${nome}-${rodada}`, trilha, ordem, titulo(nome), HASH],
      );
    }
  });
  await obterDb()
    .insert(usuario)
    .values([
      { id: idA, email: `a-${rodada}@example.test` },
      { id: idB, email: `b-${rodada}@example.test` },
      { id: idC, email: `c-${rodada}@example.test` },
    ]);
});

afterAll(async () => {
  if (!emNeon()) {
    // A cascata do usuário leva as posições; as Trilhas e os Estudos de teste saem pelo dono.
    await obterDb()
      .delete(usuario)
      .where(inArray(usuario.id, [idA, idB, idC]));
    await comoDono(async (c) => {
      await c.query("delete from conteudo.estudo where id = any($1::uuid[])", [
        [estudoXA, estudoXB, estudoY],
      ]);
      await c.query("delete from conteudo.trilha where id = any($1::text[])", [[trilhaX, trilhaY]]);
    });
  }
  await obterPool().end();
});

describe.skipIf(emNeon())("privado.posicao: cada conta vê só a própria posição", () => {
  it("A vê o Estudo dela e B o dele; ninguém vê o título do outro", async () => {
    await registrarPosicao(idA, { trilhaId: trilhaX, estudoId: estudoXA });
    await registrarPosicao(idB, { trilhaId: trilhaX, estudoId: estudoXB });

    const deA = await lerUltimaPosicao(idA);
    const deB = await lerUltimaPosicao(idB);
    // Controle positivo: cada uma vê a sua.
    expect(deA?.titulo).toBe(titulo("xa"));
    expect(deA?.slug).toBe(`teste-pos-xa-${rodada}`);
    expect(deB?.titulo).toBe(titulo("xb"));
    // Negativo: o texto de uma não aparece na leitura da outra.
    expect(JSON.stringify(deA)).not.toContain(titulo("xb"));
    expect(JSON.stringify(deB)).not.toContain(titulo("xa"));
  });

  it("quem nunca abriu um Estudo não tem posição (o 'Começar'), ao lado de quem tem", async () => {
    expect(await lerUltimaPosicao(idC)).toBeNull();
    expect(await lerUltimaPosicao(idA)).not.toBeNull();
  });

  it("a RLS decide sozinha: sem filtro algum, a conta vê só as suas linhas", async () => {
    // Controle: as duas linhas EXISTEM (contagem do dono do banco, que ignora a RLS).
    const existentes = await comoDono(async (c) => {
      const r = await c.query(
        "select count(*)::int as n from privado.posicao where estudante_id = any($1::uuid[])",
        [[idA, idB]],
      );
      return r.rows[0]?.n as number;
    });
    expect(existentes).toBe(2);

    // A leitura abaixo não tem WHERE nenhum.
    const vistasPorA = await comEstudante(idA, (tx) =>
      tx.select({ dono: posicao.estudanteId }).from(posicao),
    );
    expect(vistasPorA.length).toBeGreaterThanOrEqual(1);
    for (const l of vistasPorA) expect(l.dono).toBe(idA);
    const vistasPorB = await comEstudante(idB, (tx) =>
      tx.select({ dono: posicao.estudanteId }).from(posicao),
    );
    expect(vistasPorB.length).toBeGreaterThanOrEqual(1);
    for (const l of vistasPorB) expect(l.dono).toBe(idB);
    // A conta sem posição vê zero, embora haja linhas de outras.
    expect(await comEstudante(idC, (tx) => tx.select().from(posicao))).toHaveLength(0);
    // O papel do aplicativo, sem identidade nenhuma, vê zero linhas (FORCE + política por identidade).
    const semIdentidade = await obterPool().query("select count(*)::int as n from privado.posicao");
    expect(semIdentidade.rows[0]?.n).toBe(0);
  });

  it("A não altera nem apaga a posição de B, e não grava no nome de B", async () => {
    const mudadas = await comEstudante(idA, (tx) =>
      tx.update(posicao).set({ estudoId: estudoXA }).where(eq(posicao.estudanteId, idB)),
    );
    expect(mudadas.rowCount).toBe(0);
    const apagadas = await comEstudante(idA, (tx) =>
      tx.delete(posicao).where(eq(posicao.estudanteId, idB)),
    );
    expect(apagadas.rowCount).toBe(0);
    // A escrita no nome de B é recusada pelo banco (WITH CHECK), não por um filtro nosso.
    const erro = await comEstudante(idA, (tx) =>
      tx.insert(posicao).values({ estudanteId: idB, trilhaId: trilhaY, estudoId: estudoY }),
    ).catch((e: unknown) => e);
    expect(codigoDe(erro)).toBe("42501");
    // B continua com a posição dela, intacta (controle).
    expect((await lerUltimaPosicao(idB))?.titulo).toBe(titulo("xb"));
  });

  it("uma linha por Estudante e Trilha: abrir outro Estudo da mesma Trilha troca; entre Trilhas vale a mais recente", async () => {
    await registrarPosicao(idA, { trilhaId: trilhaX, estudoId: estudoXB });
    const linhas = await comEstudante(idA, (tx) => tx.select().from(posicao));
    expect(linhas.filter((l) => l.trilhaId === trilhaX)).toHaveLength(1);
    expect((await lerUltimaPosicao(idA))?.titulo).toBe(titulo("xb"));
    // Outra Trilha, aberta depois: passa a ser a última (e a de B não muda).
    await registrarPosicao(idA, { trilhaId: trilhaY, estudoId: estudoY });
    expect((await lerUltimaPosicao(idA))?.titulo).toBe(titulo("y"));
    expect((await lerUltimaPosicao(idB))?.titulo).toBe(titulo("xb"));
  });

  it("id que não é uuid falha antes de qualquer SQL", async () => {
    await expect(lerUltimaPosicao("não-é-uuid")).rejects.toThrow();
    await expect(
      registrarPosicao("não-é-uuid", { trilhaId: trilhaX, estudoId: estudoXA }),
    ).rejects.toThrow();
  });

  it("apagar a conta apaga a posição (cascata) e só a dela", async () => {
    const id = randomUUID();
    await obterDb()
      .insert(usuario)
      .values({ id, email: `d-${id}@example.test` });
    await registrarPosicao(id, { trilhaId: trilhaX, estudoId: estudoXA });
    expect(await lerUltimaPosicao(id)).not.toBeNull();
    await obterDb().delete(usuario).where(eq(usuario.id, id));
    const restantes = await comoDono(async (c) => {
      const dela = await c.query(
        "select count(*)::int as n from privado.posicao where estudante_id = $1",
        [id],
      );
      return dela.rows[0]?.n as number;
    });
    expect(restantes).toBe(0);
    expect(await lerUltimaPosicao(idB)).not.toBeNull(); // controle: a de B continua
  });
});

// Pool de uma conexão: toda transação, de qualquer conta, passa pela MESMA conexão física. Se a
// identidade vazasse de uma para a próxima, a leitura de uma conta mostraria o Estudo da outra.
describe.skipIf(emNeon())("posição em conexão agrupada de tamanho 1", () => {
  const cliente1 = (() => {
    aplicarEnvDeTeste();
    return criarCliente({ max: 1 });
  })();
  const porta1 = fabricarComEstudante(() => cliente1.db);

  afterAll(async () => {
    await cliente1.pool.end();
  });

  it("transações concorrentes alternadas entre A, B e a conta sem posição não se misturam", async () => {
    await registrarPosicao(idA, { trilhaId: trilhaX, estudoId: estudoXA }, porta1);
    await registrarPosicao(idB, { trilhaId: trilhaX, estudoId: estudoXB }, porta1);
    const esperado = new Map<string, string | null>([
      [idA, titulo("xa")],
      [idB, titulo("xb")],
      [idC, null],
    ]);
    // Nesta altura A tem as duas Trilhas (X e Y): a mais recente foi gravada agora, em X.
    const pedidos = Array.from({ length: 24 }, (_, i) => [idA, idB, idC][i % 3] as string);
    const lidas = await Promise.all(
      pedidos.map(async (id) => ({ id, lida: await lerUltimaPosicao(id, porta1) })),
    );
    for (const { id, lida } of lidas) {
      expect(lida?.titulo ?? null, `conta ${id.slice(0, 4)}`).toBe(esperado.get(id));
    }
    // Controle positivo: a conta com posição apareceu (não é um teste de "tudo nulo").
    expect(lidas.filter((l) => l.lida !== null).length).toBe(16);
    // Depois do COMMIT nada fica visível sem identidade na mesma conexão física.
    const resto = await cliente1.pool.query(
      "select current_setting('app.estudante_id', true) as ident, (select count(*)::int from privado.posicao) as n",
    );
    expect(resto.rows[0]?.ident ?? "").toBe("");
    expect(resto.rows[0]?.n).toBe(0);
  });

  it("a mesma consulta fora da transação com identidade não enxerga linha alguma (sql direto)", async () => {
    const r = await cliente1.db.execute(sql`select count(*)::int as n from privado.posicao`);
    expect((r.rows[0] as { n: number }).n).toBe(0);
  });
});
