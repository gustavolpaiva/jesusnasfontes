import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { usuario } from "@/db/schema/fundacao";
import { urlDoPapel } from "@/db/url";
import { listarCaderno, POR_PAGINA } from "@/modules/caderno/caderno";
import { MARCA_FIM, MARCA_INICIO } from "@/modules/caderno/marcas";
import { dividirTrecho } from "@/modules/caderno/trecho";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Caderno (ANOT-03, PRIV-04): lista e busca por palavra, no servidor, por `comEstudante`. Banco descartável
// só deste arquivo (cria Estudos e linhas). O bloco do catálogo e o do banco real são só leitura e rodam
// também no Neon (lá, a consulta roda com uma conta que não existe: zero linhas, e prova que ela compila).

const emNeon = () => inject("alvoBanco") === "neon";

const rodada = randomUUID();
const trilha = `trilha-cad-${rodada.slice(0, 8)}`;
const HASH = createHash("sha256").update(rodada).digest("hex");
const N_ESTUDOS = 25;
const estudos = Array.from({ length: N_ESTUDOS }, (_, i) => ({
  id: randomUUID(),
  slug: `cad-${i}-${rodada}`,
  titulo: `Estudo ${i} ${rodada.slice(0, 6)}`,
}));
const E = (i: number) => estudos[i] as (typeof estudos)[number];
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

async function comoDono<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

async function novaConta(): Promise<string> {
  const id = randomUUID();
  await obterDb()
    .insert(usuario)
    .values({ id, email: `cd-${id}@example.test` });
  return id;
}

const anotar = (estudante: string, estudo: string, corpo: string, em?: string) =>
  comoDono((c) =>
    c.query(
      `insert into privado.anotacao (estudante_id, estudo_id, corpo, atualizado_em)
       values ($1, $2, $3, coalesce($4::timestamptz, now()))`,
      [estudante, estudo, corpo, em ?? null],
    ),
  );

const sessao = (
  estudante: string,
  de: string,
  ate: string | null,
  texto: string | null,
  em: string,
  aberta = false,
) =>
  comoDono((c) =>
    c.query(
      `insert into privado.sessao (estudante_id, check_in_em, check_out_em, estudo_inicio_id, estudo_fim_id, anotacao)
       values ($1, $2::timestamptz, ${aberta ? "null" : "$2::timestamptz + interval '10 minutes'"}, $3, $4, $5)`,
      [estudante, em, de, ate, texto],
    ),
  );

beforeAll(async () => {
  if (emNeon()) {
    aplicarEnvDeTeste();
    return;
  }
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  await comoCarga(async (c) => {
    await c.query(
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, 1, 'x')",
      [trilha, `Trilha ${rodada}`],
    );
    for (const [i, e] of estudos.entries()) {
      await c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, $4, $5, 'devocional', 'x', $6)`,
        [e.id, e.slug, trilha, i + 1, e.titulo, HASH],
      );
    }
  });
});

afterAll(async () => {
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe("a busca usa a coluna tsv das duas tabelas (só leitura, vale também no Neon)", () => {
  it("privado.anotacao e privado.sessao têm tsv gerada com public.pt_unaccent e índice GIN", async () => {
    const r = await obterPool().query<{ tabela: string; expr: string; gin: boolean }>(`
      select c.relname as tabela, pg_get_expr(d.adbin, d.adrelid) as expr,
             exists (select 1 from pg_index i join pg_class ic on ic.oid = i.indexrelid
                     join pg_am am on am.oid = ic.relam
                     where i.indrelid = c.oid and am.amname = 'gin'
                       and i.indkey::int2[] @> array[a.attnum]) as gin
      from pg_class c
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tsv'
      join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where c.relnamespace = 'privado'::regnamespace and c.relname in ('anotacao', 'sessao')
      order by 1`);
    expect(r.rows.map((l) => l.tabela)).toEqual(["anotacao", "sessao"]);
    for (const l of r.rows) {
      expect(l.expr).toContain("pt_unaccent");
      expect(l.gin).toBe(true);
    }
  });

  it("a consulta do Caderno roda no banco real e, para uma conta sem linhas, devolve nada (a RLS decide)", async () => {
    const vazia = await listarCaderno(randomUUID());
    expect(vazia).toEqual({ entradas: [], total: 0, proximo: null });
    const busca = await listarCaderno(randomUUID(), { termo: "perdão" });
    expect(busca).toEqual({ entradas: [], total: 0, proximo: null });
  });
});

describe.skipIf(emNeon())("lista e busca do Caderno", () => {
  it("A acha 'perdão' escrevendo 'perdao' (ou 'PERDAO'), com a palavra marcada e o resto como texto", async () => {
    const a = await novaConta();
    await anotar(a, E(0).id, "Pensei no perdão que Jesus oferece ao pecador.");
    for (const termo of ["perdao", "PERDAO", "Perdão", "perdã"]) {
      const r = await listarCaderno(a, { termo });
      // "perdã" é parte de uma palavra: a busca é por palavra inteira (sem prefixo).
      if (termo === "perdã") {
        expect(r.total).toBe(0);
        continue;
      }
      expect(r.total, termo).toBe(1);
      const [entrada] = r.entradas;
      expect(entrada?.tipo).toBe("anotacao");
      const partes = dividirTrecho(entrada?.trecho ?? "");
      expect(partes.filter((p) => p.achado).map((p) => p.texto)).toEqual(["perdão"]);
      expect(partes.map((p) => p.texto).join("")).toContain("Pensei no perdão que Jesus");
    }
  });

  it("B não acha a palavra que só existe na Anotação de A; A acha (controle positivo)", async () => {
    const a = await novaConta();
    const b = await novaConta();
    const palavra = `unica${rodada.slice(0, 8).replaceAll("-", "")}`;
    await anotar(a, E(0).id, `A escreveu ${palavra} aqui.`);
    await anotar(b, E(0).id, "B escreveu outra coisa.");
    expect((await listarCaderno(a, { termo: palavra })).total).toBe(1);
    const deB = await listarCaderno(b, { termo: palavra });
    expect(deB).toEqual({ entradas: [], total: 0, proximo: null });
    // Também sem busca: B só vê a própria.
    const lista = await listarCaderno(b);
    expect(lista.total).toBe(1);
    expect(JSON.stringify(lista)).not.toContain(palavra);
  });

  it("a Anotação de Sessão entra no resultado, com o intervalo; a sem texto e a aberta, não", async () => {
    const a = await novaConta();
    const palavra = `gratidao${rodada.slice(0, 6).replaceAll("-", "")}`;
    await sessao(a, E(1).id, E(3).id, `Terminei com ${palavra}.`, "2026-11-10T14:05:00Z");
    await sessao(a, E(1).id, E(1).id, null, "2026-11-11T14:05:00Z");
    await sessao(a, E(1).id, E(1).id, "   ", "2026-11-12T14:05:00Z");
    await sessao(a, E(2).id, null, `aberta ${palavra}`, "2026-11-13T14:05:00Z", true);
    const r = await listarCaderno(a, { termo: palavra });
    expect(r.total).toBe(1);
    expect(r.entradas[0]).toMatchObject({
      tipo: "sessao",
      de: E(1).titulo,
      ate: E(3).titulo,
      titulo: null,
      slug: null,
    });
    expect(r.entradas[0]?.fimEm).not.toBeNull();
    // A lista completa traz só a Sessão encerrada com texto.
    expect((await listarCaderno(a)).total).toBe(1);
  });

  it("a Anotação traz o título e o endereço do Estudo; a mais recente vem primeiro", async () => {
    const a = await novaConta();
    await anotar(a, E(0).id, "antiga", "2026-01-01T10:00:00Z");
    await anotar(a, E(1).id, "nova", "2026-06-01T10:00:00Z");
    const r = await listarCaderno(a);
    expect(r.entradas.map((e) => e.trecho)).toEqual(["nova", "antiga"]);
    expect(r.entradas[0]).toMatchObject({ titulo: E(1).titulo, slug: E(1).slug });
  });

  it("20 por vez, sem repetir nem pular, com o total e a última página sem cursor", async () => {
    const a = await novaConta();
    // 25 Anotações e 22 Sessões com texto, em instantes distintos e alguns IGUAIS (o desempate é pelo id).
    for (let i = 0; i < N_ESTUDOS; i++) {
      await anotar(
        a,
        E(i).id,
        `anotacao-${i}`,
        `2026-03-${String(i + 1).padStart(2, "0")}T12:00:00Z`,
      );
    }
    for (let i = 0; i < 22; i++) {
      await sessao(
        a,
        E(0).id,
        E(1).id,
        `sessao-${i}`,
        `2026-04-${String((i % 22) + 1).padStart(2, "0")}T12:00:00Z`,
      );
    }
    const total = N_ESTUDOS + 22;
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const pagina = await listarCaderno(a, { cursor });
      paginas++;
      expect(pagina.total).toBe(total);
      expect(pagina.entradas.length).toBeLessThanOrEqual(POR_PAGINA);
      vistos.push(...pagina.entradas.map((e) => e.chave));
      cursor = pagina.proximo;
      if (cursor) expect(pagina.entradas).toHaveLength(POR_PAGINA);
    } while (cursor);
    expect(paginas).toBe(3);
    expect(vistos).toHaveLength(total);
    expect(new Set(vistos).size).toBe(total);
  });

  it("a paginação funciona também na busca", async () => {
    const a = await novaConta();
    for (let i = 0; i < N_ESTUDOS; i++) {
      await anotar(a, E(i).id, `luz da manhã ${i}`);
    }
    const p1 = await listarCaderno(a, { termo: "manha" });
    expect(p1.entradas).toHaveLength(POR_PAGINA);
    expect(p1.total).toBe(N_ESTUDOS);
    const p2 = await listarCaderno(a, { termo: "manha", cursor: p1.proximo });
    expect(p2.entradas).toHaveLength(N_ESTUDOS - POR_PAGINA);
    expect(p2.proximo).toBeNull();
    const todas = [...p1.entradas, ...p2.entradas].map((e) => e.chave);
    expect(new Set(todas).size).toBe(N_ESTUDOS);
  });

  it("um cursor que não é nosso é recusado antes de ir ao banco", async () => {
    const a = await novaConta();
    for (const ruim of ["x", "2026-01-01|anotacao:1", "'; drop table privado.anotacao; --"]) {
      await expect(listarCaderno(a, { cursor: ruim })).rejects.toThrow("cursor inválido");
    }
  });

  it("o termo vai por parâmetro: aspas e comandos de busca não quebram nem enxergam o que não é da conta", async () => {
    const a = await novaConta();
    await anotar(a, E(0).id, "texto com aspas e outra palavra");
    for (const termo of [
      `"`,
      `'`,
      `a' or '1'='1`,
      `!!!`,
      `:*`,
      `a & b | c`,
      "perdão -paz OR graça",
    ]) {
      const r = await listarCaderno(a, { termo });
      expect(r.total).toBeGreaterThanOrEqual(0);
    }
    // Controle: "or" do termo do usuário é operador do `websearch`, nunca SQL.
    expect((await listarCaderno(a, { termo: "aspas or inexistente" })).total).toBe(1);
  });

  it("marcador do destaque que a pessoa escreveu no texto não vira destaque falso", async () => {
    const a = await novaConta();
    await anotar(a, E(0).id, `antes ${MARCA_INICIO}falso${MARCA_FIM} depois verdadeira`);
    const r = await listarCaderno(a, { termo: "verdadeira" });
    const partes = dividirTrecho(r.entradas[0]?.trecho ?? "");
    expect(partes.filter((p) => p.achado).map((p) => p.texto)).toEqual(["verdadeira"]);
  });

  it("sem busca, o trecho é o começo do texto, sem marcadores", async () => {
    const a = await novaConta();
    await anotar(a, E(0).id, `${"x".repeat(900)}`);
    const r = await listarCaderno(a);
    expect(r.entradas[0]?.trecho).toHaveLength(600);
    expect(r.entradas[0]?.trecho).not.toContain(MARCA_INICIO);
  });
});

describe("dividirTrecho (sem banco)", () => {
  it("divide só nos marcadores e mantém o resto como texto comum, inclusive HTML que a pessoa escreveu", () => {
    const partes = dividirTrecho(
      `a <b>${MARCA_INICIO}perdão${MARCA_FIM}</b> e ${MARCA_INICIO}paz${MARCA_FIM}`,
    );
    expect(partes).toEqual([
      { texto: "a <b>", achado: false },
      { texto: "perdão", achado: true },
      { texto: "</b> e ", achado: false },
      { texto: "paz", achado: true },
    ]);
  });

  it("marcador sem par não perde texto e trecho sem marcador vira uma parte só", () => {
    expect(
      dividirTrecho(`um ${MARCA_INICIO}solto`)
        .map((p) => p.texto)
        .join(""),
    ).toBe("um solto");
    expect(dividirTrecho("só texto")).toEqual([{ texto: "só texto", achado: false }]);
    expect(dividirTrecho("")).toEqual([]);
  });
});
