import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { ConteudoMudou } from "@/modules/acervo/erros";
import { interpretarFichaYaml } from "@/modules/acervo/schemas";
import { conferirItemUmaVez, verificarFichaUmaVez } from "@/modules/acervo/verificacao";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { criarSessaoDeTeste } from "../../support/sessao-admin-banco";

// "Já conferido / já verificado para este hash?" é decidido PELO BANCO, sob a trava que grava (migração 0026): duas abas
// do Admin ao mesmo tempo gravam UMA vez e auditam UMA vez. A corrida usa DUAS CONEXÕES REAIS, cada uma com a sessão de
// um Admin com segundo fator, e é determinística: a primeira transação fica ABERTA segurando a trava, a segunda é
// lançada, o teste espera (pg_stat_activity) a segunda ficar bloqueada num lock, e só então a primeira confirma.
// A mutação (a trava da 0026 trocada por FOR SHARE, que não serializa) tem de fazer o teste da corrida falhar.
// Cria dado: banco descartável SÓ deste arquivo, fora do Neon.

vi.mock("server-only", () => ({}));

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas");
const MIGRACAO = readFileSync(
  path.join(RAIZ, "db", "migrations", "0026_acervo_verificacao_uma_vez.sql"),
  "utf8",
);
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let superusuario: pg.Client;
let carga: pg.Client;
let migra: pg.Client;
let appA: pg.Client;
let appB: pg.Client;
let sessaoA: string;
let sessaoB: string;

async function conectar(papel: "carga" | "migra" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

let n = 0;
type FichaDeTeste = { slug: string; fichaId: string; itens: string[] };

async function carregarFicha(): Promise<FichaDeTeste> {
  n++;
  const slug = `uma-vez-${n}`;
  const yaml = readFileSync(path.join(PASTA_FIXTURES, "obra-de-teste.yaml"), "utf8").replace(
    /^slug: .*$/m,
    `slug: ${slug}`,
  );
  await carregarRascunhos([interpretarFichaYaml(yaml, `${slug}.yaml`)], { cliente: carga });
  const fonte = await superusuario.query<{ id: string }>(
    "select id from acervo.fonte where slug = $1",
    [slug],
  );
  const fichaId = (fonte.rows[0] as { id: string }).id;
  const itens = await superusuario.query<{ id: string }>(
    "select id from acervo.ficha_item where ficha_id = $1 order by tipo, ordem",
    [fichaId],
  );
  return { slug, fichaId, itens: itens.rows.map((i) => i.id) };
}

const hashDoItem = async (id: string) =>
  (
    (await superusuario.query("select conteudo_hash from acervo.ficha_item where id = $1", [id]))
      .rows[0] as { conteudo_hash: string }
  ).conteudo_hash;
const hashDaFicha = async (id: string) =>
  (
    (await superusuario.query("select conteudo_hash from acervo.ficha where fonte_id = $1", [id]))
      .rows[0] as { conteudo_hash: string }
  ).conteudo_hash;
const contar = async (consulta: string, params: unknown[]) =>
  Number(((await superusuario.query(consulta, params)).rows[0] as { n: number }).n);
const conferenciasDe = (item: string) =>
  contar("select count(*)::int as n from acervo.conferencia_item where item_id = $1", [item]);
const verificacoesDe = (ficha: string) =>
  contar("select count(*)::int as n from acervo.verificacao_ficha where ficha_id = $1", [ficha]);
const registrosDe = (alvo: string, acao: string) =>
  contar(
    "select count(*)::int as n from admin.registro_verificacao where alvo = $1 and acao = $2",
    [alvo, acao],
  );

/** Espera a conexão de `pid` ficar bloqueada num lock: prova que a segunda transação chegou DEPOIS da primeira, com ela aberta. */
async function esperarBloqueio(pid: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await superusuario.query(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolver) => setTimeout(resolver, 50));
  }
  throw new Error("a segunda transação não ficou esperando o lock");
}

const pidDe = async (c: pg.Client) =>
  ((await c.query("select pg_backend_pid() as pid")).rows[0] as { pid: number }).pid;

async function abrir(c: pg.Client, sessao: string) {
  await c.query("begin");
  await c.query("select set_config('app.sessao_admin', $1, true)", [sessao]);
}

/**
 * A corrida. A (aberta, segurando a trava) chama; B chama e fica esperando; A confirma; B termina.
 * `chamar(c, sessao)` devolve o que a função do banco devolveu.
 */
async function corrida<T>(chamar: (c: pg.Client, sessao: string) => Promise<T>): Promise<[T, T]> {
  await abrir(appA, sessaoA);
  await abrir(appB, sessaoB);
  // O pid vem ANTES: com a consulta de B pendurada no lock, a conexão dele não responde a mais nada.
  const pidB = await pidDe(appB);
  try {
    const ra = await chamar(appA, sessaoA);
    const pB = chamar(appB, sessaoB);
    await esperarBloqueio(pidB);
    await appA.query("commit");
    const rb = await pB;
    await appB.query("commit");
    return [ra, rb];
  } catch (erro) {
    await appA.query("rollback").catch(() => {});
    await appB.query("rollback").catch(() => {});
    throw erro;
  }
}

const chamarConferir = (item: string, hash: string) => async (c: pg.Client, sessao: string) =>
  (
    (
      await c.query("select acervo.conferir_item_uma_vez($1::uuid, $2, $3) as gravou", [
        sessao,
        item,
        hash,
      ])
    ).rows[0] as { gravou: boolean }
  ).gravou;

const chamarVerificar = (ficha: string, hash: string) => async (c: pg.Client, sessao: string) =>
  (
    (
      await c.query(
        "select gravou, em from acervo.verificar_ficha_uma_vez($1::uuid, $2::uuid, $3)",
        [sessao, ficha, hash],
      )
    ).rows[0] as { gravou: boolean; em: Date }
  ).gravou;

/** Confere todos os itens da ficha, em série, pelo módulo real. */
async function conferirTodos(f: FichaDeTeste) {
  for (const id of f.itens) await conferirItemUmaVez(sessaoA, id, await hashDoItem(id));
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  superusuario = new pg.Client({ connectionString: preparado.banco.url });
  await superusuario.connect();
  carga = await conectar("carga");
  migra = await conectar("migra");
  appA = await conectar("app");
  appB = await conectar("app");
  sessaoA = (await criarSessaoDeTeste(superusuario, "admin-com-segundo-fator")).sessaoId;
  sessaoB = (await criarSessaoDeTeste(superusuario, "admin-com-segundo-fator")).sessaoId;
}, 180_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [appA, appB, carga, migra, superusuario]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("conferir e verificar uma vez, decidido pelo banco", () => {
  it("controle positivo: uma chamada sozinha grava (true) e a repetida não regrava nem audita (false)", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const hash = await hashDoItem(item);
    expect(await conferirItemUmaVez(sessaoA, item, hash)).toBe(true);
    const antes = (
      await superusuario.query<{ t: string }>(
        "select conferida_em::text as t from acervo.conferencia_item where item_id = $1",
        [item],
      )
    ).rows[0]?.t;
    expect(await conferirItemUmaVez(sessaoB, item, hash)).toBe(false);
    expect(await conferenciasDe(item)).toBe(1);
    expect(await registrosDe(item, "conferir-item")).toBe(1);
    expect(
      (
        await superusuario.query<{ t: string }>(
          "select conferida_em::text as t from acervo.conferencia_item where item_id = $1",
          [item],
        )
      ).rows[0]?.t,
    ).toBe(antes);

    await conferirTodos(f);
    const fh = await hashDaFicha(f.fichaId);
    const primeira = await verificarFichaUmaVez(sessaoA, f.fichaId, fh);
    expect(primeira.gravou).toBe(true);
    const segunda = await verificarFichaUmaVez(sessaoB, f.fichaId, fh);
    expect(segunda.gravou).toBe(false);
    expect(segunda.verificadaEm.getTime()).toBe(primeira.verificadaEm.getTime());
    expect(await verificacoesDe(f.fichaId)).toBe(1);
    expect(await registrosDe(f.slug, "verificar-ficha")).toBe(1);
  });

  it("hash velho continua recusado (40001) mesmo com a evidência antiga na tabela", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const velho = await hashDoItem(item);
    expect(await conferirItemUmaVez(sessaoA, item, velho)).toBe(true);
    await superusuario.query(
      "update acervo.ficha_item set texto_pt = texto_pt || ' (mudou)' where id = $1",
      [item],
    );
    await expect(conferirItemUmaVez(sessaoA, item, velho)).rejects.toBeInstanceOf(ConteudoMudou);
  });

  it("CORRIDA no mesmo item, duas conexões reais: uma gravação, uma linha de auditoria; a outra recebe 'já conferido'", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const hash = await hashDoItem(item);
    const [ra, rb] = await corrida(chamarConferir(item, hash));
    expect([ra, rb]).toEqual([true, false]);
    expect(await conferenciasDe(item)).toBe(1);
    expect(await registrosDe(item, "conferir-item")).toBe(1);
  });

  it("CORRIDA na mesma ficha, duas conexões reais: uma verificação, uma linha de auditoria; a outra recebe 'já verificada'", async () => {
    const f = await carregarFicha();
    await conferirTodos(f);
    const hash = await hashDaFicha(f.fichaId);
    const [ra, rb] = await corrida(chamarVerificar(f.fichaId, hash));
    expect([ra, rb]).toEqual([true, false]);
    expect(await verificacoesDe(f.fichaId)).toBe(1);
    expect(await registrosDe(f.slug, "verificar-ficha")).toBe(1);
  });

  it("pelo módulo, em paralelo no pool: exatamente um true em cada porta, uma auditoria", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const hash = await hashDoItem(item);
    const rs = await Promise.all([
      conferirItemUmaVez(sessaoA, item, hash),
      conferirItemUmaVez(sessaoB, item, hash),
    ]);
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect(await registrosDe(item, "conferir-item")).toBe(1);

    await conferirTodos(f);
    const fh = await hashDaFicha(f.fichaId);
    const vs = await Promise.all([
      verificarFichaUmaVez(sessaoA, f.fichaId, fh),
      verificarFichaUmaVez(sessaoB, f.fichaId, fh),
    ]);
    expect(vs.filter((v) => v.gravou)).toHaveLength(1);
    expect(vs[0]?.verificadaEm.getTime()).toBe(vs[1]?.verificadaEm.getTime());
    expect(await registrosDe(f.slug, "verificar-ficha")).toBe(1);
  });
});

describe.skipIf(emNeon())("mutação: sem a trava FOR UPDATE a corrida grava duas vezes", () => {
  async function comTravaRemovida<T>(corpo: () => Promise<T>): Promise<T> {
    const mutada = MIGRACAO.replace(/\bfor update\b/g, "for share");
    // A mutação tem de ter mexido na migração (controle: se não achou a trava, o teste não prova nada).
    expect(mutada).not.toBe(MIGRACAO);
    await migra.query(mutada);
    try {
      return await corpo();
    } finally {
      await migra.query(MIGRACAO);
    }
  }

  it("item: sem a trava os dois gravam e auditam duas vezes (o teste da corrida reprovaria)", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const hash = await hashDoItem(item);
    const [ra, rb] = await comTravaRemovida(() => corrida(chamarConferir(item, hash)));
    expect([ra, rb]).toEqual([true, true]);
    expect(await registrosDe(item, "conferir-item")).toBe(2);
  });

  it("ficha: sem a trava os dois verificam e auditam duas vezes", async () => {
    const f = await carregarFicha();
    await conferirTodos(f);
    const hash = await hashDaFicha(f.fichaId);
    const [ra, rb] = await comTravaRemovida(() => corrida(chamarVerificar(f.fichaId, hash)));
    expect([ra, rb]).toEqual([true, true]);
    expect(await registrosDe(f.slug, "verificar-ficha")).toBe(2);
  });

  it("com a migração restaurada a corrida volta a gravar uma vez só", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const [ra, rb] = await corrida(chamarConferir(item, await hashDoItem(item)));
    expect([ra, rb]).toEqual([true, false]);
    expect(await registrosDe(item, "conferir-item")).toBe(1);
  });
});
