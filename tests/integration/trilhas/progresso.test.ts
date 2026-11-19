import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { criarCliente, obterDb, obterPool } from "@/db/cliente";
import { comEstudante, fabricarComEstudante } from "@/db/com-estudante";
import { usuario } from "@/db/schema/fundacao";
import { conclusao, voltaLeitura } from "@/db/schema/progresso";
import { urlDoPapel } from "@/db/url";
import {
  iniciarNovaVolta,
  lerEstadoDoEstudo,
  listarTrilhas,
  registrarConclusao,
  removerConclusao,
  TRILHA_LEITURA_CONTINUA,
} from "@/modules/trilhas/consultas";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Progresso: dado privado do Estudante. Duas contas e dois conjuntos de Estudos, e cada "A não vê B"
// tem ao lado o controle positivo "A vê o que é dela". Este arquivo cria e usa um banco descartável SÓ
// dele (como o executor de e2e): o do projeto é compartilhado com os testes de carga de conteúdo, que
// contam os Estudos do banco inteiro, e Estudos criados aqui ao mesmo tempo fariam essa contagem variar.
// Cria linhas, então não roda no Neon.

const emNeon = () => inject("alvoBanco") === "neon";

const rodada = randomUUID();
const idA = randomUUID();
const idB = randomUUID();
const trilhaV = TRILHA_LEITURA_CONTINUA; // a Trilha que tem voltas
const trilhaS = "pontos-centrais"; // uma Trilha comum (sempre a volta 1)
const estudoV = [randomUUID(), randomUUID(), randomUUID()];
const estudoS = [randomUUID(), randomUUID()];
const HASH = createHash("sha256").update(rodada).digest("hex");
const opcoes = {};
let banco: BancoDeExecucao | undefined;

async function comoCarga<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

// Dono do banco descartável: ignora a RLS e serve de "contagem verdadeira".
async function comoDono<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

const contagemReal = (estudante: string, estudo: string, volta?: number) =>
  comoDono(async (c) => {
    const r = await c.query(
      `select count(*)::int as n from privado.conclusao
       where estudante_id = $1 and estudo_id = $2 and ($3::int is null or volta = $3)`,
      [estudante, estudo, volta ?? null],
    );
    return r.rows[0]?.n as number;
  });

const codigoDe = (erro: unknown) =>
  (erro as { code?: string; cause?: { code?: string } }).code ??
  (erro as { cause?: { code?: string } }).cause?.code;

const daTrilha = async (estudante: string, id: string, extra = opcoes) =>
  (await listarTrilhas(estudante, extra)).find((t) => t.id === id);

beforeAll(async () => {
  if (emNeon()) return;
  // O ambiente do banco próprio vale para todo o arquivo (o pool do aplicativo nasce depois disto).
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  await comoCarga(async (c) => {
    await c.query(
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, 3, 'x'), ($3, $4, 2, 'x')",
      [trilhaV, `Trilha V ${rodada}`, trilhaS, `Trilha S ${rodada}`],
    );
    const estudos: [string, string, string, number][] = [
      [estudoV[0] as string, trilhaV, "v1", 1],
      [estudoV[1] as string, trilhaV, "v2", 2],
      [estudoV[2] as string, trilhaV, "v3", 3],
      [estudoS[0] as string, trilhaS, "s1", 1],
      [estudoS[1] as string, trilhaS, "s2", 2],
    ];
    for (const [id, trilha, nome, ordem] of estudos) {
      await c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, $4, $5, 'devocional', 'x', $6)`,
        [
          id,
          `teste-prog-${nome}-${rodada}`,
          trilha,
          ordem,
          `Título ${nome} ${rodada.slice(0, 8)}`,
          HASH,
        ],
      );
    }
  });
  await obterDb()
    .insert(usuario)
    .values([
      { id: idA, email: `a-prog-${rodada}@example.test` },
      { id: idB, email: `b-prog-${rodada}@example.test` },
    ]);
});

afterAll(async () => {
  if (emNeon()) return;
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("privado.conclusao: cada conta vê só o próprio progresso", () => {
  it("a conclusão de A é invisível para B, ao lado do controle positivo de A", async () => {
    const feito = await registrarConclusao(idA, estudoV[0] as string, opcoes);
    expect(feito).toMatchObject({ concluidos: 1, total: 3, volta: 1 });

    // Controle positivo: A vê a dela, no resumo e na lista.
    const deA = await daTrilha(idA, trilhaV);
    expect(deA).toMatchObject({ concluidos: 1, total: 3 });
    expect(deA?.estudos.find((e) => e.id === estudoV[0])?.concluido).toBe(true);
    // Negativo: B vê zero concluídos na mesma Trilha, embora a linha de A exista de verdade.
    expect(await contagemReal(idA, estudoV[0] as string)).toBe(1);
    const deB = await daTrilha(idB, trilhaV);
    expect(deB).toMatchObject({ concluidos: 0, total: 3 });
    expect(deB?.estudos.every((e) => !e.concluido)).toBe(true);
    expect(
      (await lerEstadoDoEstudo(idB, { estudoId: estudoV[0] as string, trilhaId: trilhaV }, opcoes))
        .concluido,
    ).toBe(false);
  });

  it("a RLS decide sozinha: sem filtro algum, a conta vê só as suas linhas e o papel sem identidade, nenhuma", async () => {
    await registrarConclusao(idB, estudoS[0] as string, opcoes);
    const vistasPorA = await comEstudante(idA, (tx) =>
      tx.select({ dono: conclusao.estudanteId }).from(conclusao),
    );
    expect(vistasPorA.length).toBeGreaterThanOrEqual(1);
    for (const l of vistasPorA) expect(l.dono).toBe(idA);
    const vistasPorB = await comEstudante(idB, (tx) =>
      tx.select({ dono: conclusao.estudanteId }).from(conclusao),
    );
    expect(vistasPorB.length).toBeGreaterThanOrEqual(1);
    for (const l of vistasPorB) expect(l.dono).toBe(idB);
    const semIdentidade = await obterPool().query(
      "select (select count(*)::int from privado.conclusao) as c, (select count(*)::int from privado.volta_leitura) as v",
    );
    expect(semIdentidade.rows[0]).toEqual({ c: 0, v: 0 });
  });

  it("A não escreve, altera nem apaga no nome de B (o banco recusa, não um filtro nosso)", async () => {
    const erro = await comEstudante(idA, (tx) =>
      tx.insert(conclusao).values({ estudanteId: idB, estudoId: estudoV[1] as string, volta: 1 }),
    ).catch((e: unknown) => e);
    expect(codigoDe(erro)).toBe("42501");
    const apagadas = await comEstudante(idA, (tx) =>
      tx.delete(conclusao).where(eq(conclusao.estudanteId, idB)),
    );
    expect(apagadas.rowCount).toBe(0);
    // Controle: a conclusão de B continua lá.
    expect(await contagemReal(idB, estudoS[0] as string)).toBe(1);
    // A volta de A também não se escreve no nome de B.
    const erroVolta = await comEstudante(idA, (tx) =>
      tx.insert(voltaLeitura).values({ estudanteId: idB, voltaAtual: 9 }),
    ).catch((e: unknown) => e);
    expect(codigoDe(erroVolta)).toBe("42501");
  });

  it("concluir duas vezes não duplica; Estudo que não existe devolve nulo sem gravar nada", async () => {
    await registrarConclusao(idA, estudoV[0] as string, opcoes);
    expect(await contagemReal(idA, estudoV[0] as string)).toBe(1);
    expect(await registrarConclusao(idA, randomUUID(), opcoes)).toBeNull();
    expect(await removerConclusao(idA, randomUUID(), opcoes)).toBeNull();
  });

  it("desmarcar remove a conclusão, e só a do Estudo pedido", async () => {
    await registrarConclusao(idA, estudoV[1] as string, opcoes);
    const antes = await daTrilha(idA, trilhaV);
    expect(antes?.concluidos).toBe(2);
    const depois = await removerConclusao(idA, estudoV[1] as string, opcoes);
    expect(depois).toMatchObject({ concluidos: 1, total: 3 });
    expect(await contagemReal(idA, estudoV[0] as string)).toBe(1);
    expect(await contagemReal(idA, estudoV[1] as string)).toBe(0);
  });
});

describe.skipIf(emNeon())(
  "a volta da Leitura contínua: nada é apagado e só a volta atual se desmarca",
  () => {
    it("nova volta só com todas as casas concluídas", async () => {
      // A tem 1 de 3: recusa, e a volta não muda (controle: depois de completar, aceita).
      const cedo = await iniciarNovaVolta(idA, opcoes);
      expect(cedo).toEqual({ ok: false, erro: "incompleta" });
      expect((await daTrilha(idA, trilhaV))?.volta).toBe(1);
      // Uma Trilha vazia de conclusões de B também recusa.
      expect(await iniciarNovaVolta(idB, opcoes)).toEqual({ ok: false, erro: "incompleta" });

      await registrarConclusao(idA, estudoV[1] as string, opcoes);
      await registrarConclusao(idA, estudoV[2] as string, opcoes);
      expect(await daTrilha(idA, trilhaV)).toMatchObject({ concluidos: 3, total: 3, volta: 1 });
      expect(await iniciarNovaVolta(idA, opcoes)).toEqual({ ok: true, volta: 2 });
    });

    it("na volta 2 as casas zeram, as conclusões da volta 1 ficam no banco e desmarcar só toca a volta 2", async () => {
      const t = await daTrilha(idA, trilhaV);
      expect(t).toMatchObject({ concluidos: 0, total: 3, volta: 2 });
      expect(t?.estudos.every((e) => !e.concluido)).toBe(true);
      // As três conclusões da volta 1 continuam guardadas.
      for (const id of estudoV) expect(await contagemReal(idA, id, 1)).toBe(1);

      await registrarConclusao(idA, estudoV[0] as string, opcoes);
      expect(await contagemReal(idA, estudoV[0] as string, 2)).toBe(1);
      await removerConclusao(idA, estudoV[0] as string, opcoes);
      expect(await contagemReal(idA, estudoV[0] as string, 2)).toBe(0);
      // A da volta 1, intacta.
      expect(await contagemReal(idA, estudoV[0] as string, 1)).toBe(1);
    });

    it("a volta é de cada conta: B segue na volta 1; a Trilha comum nunca tem volta", async () => {
      expect((await daTrilha(idB, trilhaV))?.volta).toBe(1);
      // A está na volta 2 da Trilha V e continua na 1 da Trilha comum S.
      await registrarConclusao(idA, estudoS[0] as string, opcoes);
      expect(await contagemReal(idA, estudoS[0] as string, 1)).toBe(1);
      expect((await daTrilha(idA, trilhaS))?.concluidos).toBe(1);
      expect((await daTrilha(idB, trilhaS))?.concluidos).toBe(1); // a de B é dela, não da A
    });

    it("duas chamadas ao mesmo tempo sobem uma volta só", async () => {
      for (const id of estudoV) await registrarConclusao(idA, id, opcoes);
      const [a, b] = await Promise.all([
        iniciarNovaVolta(idA, opcoes),
        iniciarNovaVolta(idA, opcoes),
      ]);
      // Nunca duas voltas: ou as duas viram a 3, ou a segunda leu a volta nova e recusou por incompleta.
      expect([a.ok, b.ok]).toContain(true);
      const voltaFinal = (await daTrilha(idA, trilhaV))?.volta;
      expect(voltaFinal).toBe(3);
    });
  },
);

describe.skipIf(emNeon())("cascata e conexão agrupada de tamanho 1", () => {
  it("apagar a conta apaga o progresso e a volta dela, e só os dela", async () => {
    const id = randomUUID();
    await obterDb()
      .insert(usuario)
      .values({ id, email: `d-prog-${id}@example.test` });
    for (const e of estudoV) await registrarConclusao(id, e, opcoes);
    await iniciarNovaVolta(id, opcoes);
    await obterDb().delete(usuario).where(eq(usuario.id, id));
    const restos = await comoDono(async (c) => {
      const r = await c.query(
        `select (select count(*)::int from privado.conclusao where estudante_id = $1) as c,
                (select count(*)::int from privado.volta_leitura where estudante_id = $1) as v`,
        [id],
      );
      return r.rows[0];
    });
    expect(restos).toEqual({ c: 0, v: 0 });
    expect(await contagemReal(idA, estudoV[0] as string)).toBeGreaterThan(0); // controle
  });

  it("transações alternadas entre A e B na mesma conexão física não misturam o progresso", async () => {
    const cliente1 = criarCliente({ max: 1 });
    try {
      const porta1 = fabricarComEstudante(() => cliente1.db);
      const o = { ...opcoes, porta: porta1 };
      const pedidos = Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? idA : idB));
      const lidas = await Promise.all(
        pedidos.map(async (id) => ({ id, t: await daTrilha(id, trilhaS, o) })),
      );
      for (const { id, t } of lidas) {
        // Em S, A concluiu s1 e B concluiu s1: um cada, e cada um vê só o dele.
        expect(t?.concluidos, `conta ${id.slice(0, 4)}`).toBe(1);
      }
      // Sem identidade, na mesma conexão física, nada fica visível depois do COMMIT.
      const resto = await cliente1.pool.query(
        "select (select count(*)::int from privado.conclusao) as n",
      );
      expect(resto.rows[0]?.n).toBe(0);
    } finally {
      await cliente1.pool.end();
    }
  });
});
