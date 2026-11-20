import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { comEstudante, fabricarComEstudante } from "@/db/com-estudante";
import { anotacao, usuario } from "@/db/schema/fundacao";
import { urlDoPapel } from "@/db/url";
import { ESTUDO_DE_TESTE } from "../../support/estudo-de-teste";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Grava uma Anotação numa conta de teste: precisa do Estudo fixo do banco local compartilhado (e não cria
// conta no Neon). No Neon o arquivo é ignorado; o catálogo cobre a RLS lá.
const emNeon = () => inject("alvoBanco") === "neon";

// Duas contas, uma tabela privada. Cada afirmação negativa ("B não vê A") tem ao lado o controle
// positivo ("A vê o que é seu"), para o teste não passar só porque nada foi gravado.

type ErroPg = { code?: string; cause?: { code?: string } };
const codigoDe = (erro: unknown) => (erro as ErroPg).code ?? (erro as ErroPg).cause?.code;

const rodada = randomUUID();
const idA = randomUUID();
const idB = randomUUID();
// O Estudo fixo do banco compartilhado (chave estrangeira desde a 0013); a unicidade é por conta e Estudo.
const estudoA = ESTUDO_DE_TESTE.id;
const estudoB = ESTUDO_DE_TESTE.id;
const marcadorA = `MARCADOR-A-${rodada}`;
const marcadorB = `MARCADOR-B-${rodada}`;
let idLinhaB = "";

async function comoPapel<T>(papel: "assistente" | "migra", fn: (c: pg.Client) => Promise<T>) {
  const cliente = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: true }) });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

beforeAll(async () => {
  if (emNeon()) return;
  aplicarEnvDeTeste();
  const db = obterDb();
  await db.insert(usuario).values([
    { id: idA, email: `a-${rodada}@example.test` },
    { id: idB, email: `b-${rodada}@example.test` },
  ]);
  await comEstudante(idA, (tx) =>
    tx.insert(anotacao).values({ estudanteId: idA, estudoId: estudoA, corpo: marcadorA }),
  );
  const linhaB = await comEstudante(idB, (tx) =>
    tx
      .insert(anotacao)
      .values({ estudanteId: idB, estudoId: estudoB, corpo: marcadorB })
      .returning({ id: anotacao.id }),
  );
  idLinhaB = linhaB[0]?.id ?? "";
  if (!idLinhaB) throw new Error("linha de B não foi criada");
});

afterAll(async () => {
  if (emNeon()) return;
  // Remove só o que este arquivo criou; a cascata leva as Anotações.
  await obterDb()
    .delete(usuario)
    .where(inArray(usuario.id, [idA, idB]));
  await obterPool().end();
});

describe.skipIf(emNeon())("isolamento entre duas contas (privado.anotacao)", () => {
  it("controle positivo: cada dono vê exatamente a própria linha", async () => {
    const a = await comEstudante(idA, (tx) => tx.select().from(anotacao));
    expect(a).toHaveLength(1);
    expect(a[0]?.corpo).toBe(marcadorA);
    const b = await comEstudante(idB, (tx) => tx.select().from(anotacao));
    expect(b).toHaveLength(1);
    expect(b[0]?.corpo).toBe(marcadorB);
  });

  it("A não lê nem conta linhas de B", async () => {
    await comEstudante(idA, async (tx) => {
      const [total] = await tx.select({ n: count() }).from(anotacao);
      expect(total?.n).toBe(1);
      const daB = await tx.select().from(anotacao).where(eq(anotacao.id, idLinhaB));
      expect(daB).toHaveLength(0);
      const buscaPorEstudante = await tx
        .select()
        .from(anotacao)
        .where(eq(anotacao.estudanteId, idB));
      expect(buscaPorEstudante).toHaveLength(0);
    });
  });

  it("A não altera nem apaga linhas de B", async () => {
    await comEstudante(idA, async (tx) => {
      const alteradas = await tx
        .update(anotacao)
        .set({ corpo: "SOBRESCRITO" })
        .where(eq(anotacao.id, idLinhaB))
        .returning({ id: anotacao.id });
      expect(alteradas).toHaveLength(0);
      const apagadas = await tx
        .delete(anotacao)
        .where(eq(anotacao.estudanteId, idB))
        .returning({ id: anotacao.id });
      expect(apagadas).toHaveLength(0);
    });
    // Controle: a linha de B segue inteira, vista pelo próprio B.
    const b = await comEstudante(idB, (tx) => tx.select().from(anotacao));
    expect(b).toHaveLength(1);
    expect(b[0]?.corpo).toBe(marcadorB);
    expect(b[0]?.versao).toBe(1);
  });

  it("B não grava linha com o estudante_id de A (política recusa)", async () => {
    const tentativa = comEstudante(idB, (tx) =>
      tx
        .insert(anotacao)
        .values({ estudanteId: idA, estudoId: randomUUID(), corpo: `INTRUSO-${rodada}` }),
    );
    await expect(tentativa).rejects.toSatisfy((erro) => codigoDe(erro) === "42501");
    // E nada entrou: A continua com uma linha só.
    const a = await comEstudante(idA, (tx) => tx.select().from(anotacao));
    expect(a).toHaveLength(1);
  });

  it("B não passa a própria linha para A por update (WITH CHECK)", async () => {
    const tentativa = comEstudante(idB, (tx) =>
      tx
        .update(anotacao)
        .set({ estudanteId: idA })
        .where(and(eq(anotacao.id, idLinhaB))),
    );
    await expect(tentativa).rejects.toSatisfy((erro) => codigoDe(erro) === "42501");
  });

  it("sem identidade o banco não devolve linha alguma (falha fechada)", async () => {
    const semIdentidade = await obterPool().query(
      "select count(*)::int as n from privado.anotacao",
    );
    expect(semIdentidade.rows[0]?.n).toBe(0);
  });

  it("o dono da tabela, sem identidade, também vê 0 linhas (FORCE ROW LEVEL SECURITY)", async () => {
    const n = await comoPapel("migra", async (c) => {
      const r = await c.query("select count(*)::int as n from privado.anotacao");
      return r.rows[0]?.n as number;
    });
    expect(n).toBe(0);
  });

  it("jnf_assistente é barrado pelo banco em privado (SQLSTATE 42501)", async () => {
    await comoPapel("assistente", async (c) => {
      // Controle positivo: o papel funciona e lê o acervo.
      const acervo = await c.query("select count(*)::int as n from acervo.ambiente");
      expect(acervo.rows[0]?.n).toBe(1);
      await expect(c.query("select * from privado.anotacao")).rejects.toMatchObject({
        code: "42501",
      });
    });
  });

  it("identidade que não é uuid falha antes de chegar ao banco", async () => {
    let chegouAoBanco = false;
    let fnRodou = false;
    const porta = fabricarComEstudante(
      () => ({
        transaction: () => {
          chegouAoBanco = true;
          throw new Error("não deveria consultar");
        },
      }),
      async () => {},
    );
    for (const ruim of ["", "abc", "1; drop table privado.anotacao", `${idA}'`]) {
      await expect(
        porta(ruim, async () => {
          fnRodou = true;
        }),
      ).rejects.toThrow();
    }
    expect(chegouAoBanco).toBe(false);
    expect(fnRodou).toBe(false);
  });
});
