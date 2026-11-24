import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// ACER-09, achado ALTA da revisão cruzada do plano 02-02: nenhum caminho (INSERT ou UPDATE de parágrafo, seção ou
// das marcas da Fonte, inclusive troca de chave estrangeira e corrida entre duas transações) pode deixar texto
// integral sob Fonte de obra protegida ou de ficha. Cria dado de teste: banco descartável SÓ deste arquivo, fora
// do Neon.

const emNeon = () => inject("alvoBanco") === "neon";
const RECUSA = /texto integral recusado/;

let banco: BancoDeExecucao | undefined;
let superusuario: pg.Client;
let carga: pg.Client;
let migra: pg.Client;

async function cliente(papel: "carga" | "migra"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

type Quem = "carga" | "migra";
const quem = (q: Quem) => (q === "carga" ? carga : migra);

let n = 0;
/** Fonte com uma seção (ordem 1), pelo papel pedido. */
async function criarFonte(q: Quem, tipo: "integral" | "ficha", protegida: boolean) {
  n++;
  const slug = `fonte-de-teste-${n}`;
  const integral = tipo === "integral";
  const f = await quem(q).query<{ id: string }>(
    `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, obra_protegida, licenca, origem_url, origem_nome)
     values ($1, 'Fonte de Teste', 'academica', $2, 'en', $3, $4, $5, $6) returning id`,
    [
      slug,
      tipo,
      protegida,
      integral ? "dominio-publico" : null,
      integral ? "https://exemplo.invalid/t" : null,
      integral ? "Origem de Teste" : null,
    ],
  );
  const fonteId = (f.rows[0] as { id: string }).id;
  const secaoId = `${slug}/1`;
  await quem(q).query(
    "insert into acervo.fonte_secao (id, fonte_id, ordem, slug, titulo) values ($1, $2, 1, '1', 'Seção')",
    [secaoId, fonteId],
  );
  return { slug, fonteId, secaoId };
}

const paragrafo = (c: pg.Client, secaoId: string, ref = "1", texto = "Texto de teste.") =>
  c.query(
    "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ($1, $2, 1, $3, $4)",
    [`${secaoId}#${ref}`, secaoId, texto, ref],
  );

/** A invariante inteira: quantos parágrafos existem sob Fonte protegida ou que não é de texto integral. */
async function paragrafosProibidos(): Promise<number> {
  const r = await superusuario.query(
    `select count(*)::int as n
       from acervo.fonte_paragrafo p
       join acervo.fonte_secao s on s.id = p.secao_id
       join acervo.fonte f on f.id = s.fonte_id
      where f.obra_protegida or f.tipo_texto <> 'integral'`,
  );
  return (r.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  superusuario = new pg.Client({ connectionString: preparado.banco.url });
  await superusuario.connect();
  carga = await cliente("carga");
  migra = await cliente("migra");
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, migra, superusuario]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("ACER-09: mudar a Fonte de uma seção que tem parágrafo", () => {
  it.each(["carga", "migra"] as const)(
    "como %s: mover a seção com parágrafo para Fonte protegida (ficha) falha com 23514",
    async (q) => {
      const livre = await criarFonte(q, "integral", false);
      await paragrafo(quem(q), livre.secaoId);
      const protegida = await criarFonte(q, "ficha", true);
      // A seção da Fonte protegida ocupa a ordem 1: a seção movida pede outra, para a recusa ser a do texto.
      await expect(
        quem(q).query(
          "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
          [protegida.fonteId, livre.secaoId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        quem(q).query(
          "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
          [protegida.fonteId, livre.secaoId],
        ),
      ).rejects.toThrow(RECUSA);
      // Nada mudou: a seção continua na Fonte de origem, com o parágrafo.
      const r = await quem(q).query("select fonte_id from acervo.fonte_secao where id = $1", [
        livre.secaoId,
      ]);
      expect(r.rows).toEqual([{ fonte_id: livre.fonteId }]);
      expect(await paragrafosProibidos()).toBe(0);
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: mover a seção com parágrafo para Fonte de ficha SEM a marca de obra protegida também falha",
    async (q) => {
      const livre = await criarFonte(q, "integral", false);
      await paragrafo(quem(q), livre.secaoId);
      const ficha = await criarFonte(q, "ficha", false);
      await expect(
        quem(q).query(
          "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
          [ficha.fonteId, livre.secaoId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await paragrafosProibidos()).toBe(0);
    },
  );

  it.each(["carga", "migra"] as const)(
    "controle positivo, como %s: seção com parágrafo muda entre Fontes de texto integral, e seção vazia vai para Fonte protegida",
    async (q) => {
      const a = await criarFonte(q, "integral", false);
      const b = await criarFonte(q, "integral", false);
      await paragrafo(quem(q), a.secaoId);
      await quem(q).query(
        "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
        [b.fonteId, a.secaoId],
      );
      const r = await quem(q).query("select fonte_id from acervo.fonte_secao where id = $1", [
        a.secaoId,
      ]);
      expect(r.rows).toEqual([{ fonte_id: b.fonteId }]);

      // Seção sem parágrafo pode ir para a Fonte protegida (não há texto); o parágrafo, depois, é recusado.
      const protegida = await criarFonte(q, "ficha", true);
      const vazia = await criarFonte(q, "integral", false);
      await quem(q).query(
        "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
        [protegida.fonteId, vazia.secaoId],
      );
      await expect(paragrafo(quem(q), vazia.secaoId)).rejects.toMatchObject({ code: "23514" });
      expect(await paragrafosProibidos()).toBe(0);
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: a Fonte integral aceita parágrafo (controle positivo da inserção)",
    async (q) => {
      const f = await criarFonte(q, "integral", false);
      await expect(paragrafo(quem(q), f.secaoId)).resolves.toBeDefined();
    },
  );
});

describe.skipIf(emNeon())("ACER-09: as demais chaves móveis do Acervo seguem fechadas", () => {
  it.each(["carga", "migra"] as const)(
    "como %s: mover o parágrafo de seção para Fonte protegida falha com 23514",
    async (q) => {
      const livre = await criarFonte(q, "integral", false);
      await paragrafo(quem(q), livre.secaoId);
      const protegida = await criarFonte(q, "ficha", true);
      await expect(
        quem(q).query("update acervo.fonte_paragrafo set secao_id = $1 where secao_id = $2", [
          protegida.secaoId,
          livre.secaoId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await paragrafosProibidos()).toBe(0);
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: inserir parágrafo por upsert que cai em UPDATE para seção protegida também falha",
    async (q) => {
      const livre = await criarFonte(q, "integral", false);
      await paragrafo(quem(q), livre.secaoId);
      const protegida = await criarFonte(q, "ficha", true);
      await expect(
        quem(q).query(
          `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref)
           values ($1, $2, 1, 'Outro.', '1')
           on conflict (id) do update set secao_id = excluded.secao_id`,
          [`${livre.secaoId}#1`, protegida.secaoId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await paragrafosProibidos()).toBe(0);
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: virar protegida ou ficha depois de ter parágrafo continua recusado",
    async (q) => {
      const f = await criarFonte(q, "integral", false);
      await paragrafo(quem(q), f.secaoId);
      await expect(
        quem(q).query(
          "update acervo.fonte set obra_protegida = true, tipo_texto = 'ficha' where id = $1",
          [f.fonteId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await paragrafosProibidos()).toBe(0);
    },
  );
});

/** Espera até a conexão de `pid` estar bloqueada esperando um lock (prova que a corrida é real). */
async function esperarBloqueio(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await superusuario.query(
      "select wait_event_type from pg_stat_activity where pid = $1",
      [pid],
    );
    if (r.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolver) => setTimeout(resolver, 50));
  }
  throw new Error("a segunda transação não ficou esperando o lock");
}

const pidDe = async (c: pg.Client): Promise<number> =>
  ((await c.query("select pg_backend_pid() as pid")).rows[0] as { pid: number }).pid;

describe.skipIf(emNeon())("ACER-09: corrida entre duas transações não abre brecha", () => {
  let a: pg.Client;
  let b: pg.Client;

  beforeAll(async () => {
    if (emNeon()) return;
    a = await cliente("carga");
    b = await cliente("carga");
  });

  afterAll(async () => {
    for (const c of [a, b]) await c?.end().catch(() => {});
  });

  it("inserir parágrafo (ainda sem commit) e virar protegida em paralelo: a segunda espera e falha", async () => {
    const f = await criarFonte("carga", "integral", false);
    await a.query("begin");
    await paragrafo(a, f.secaoId);
    const pidB = await pidDe(b);
    const virar = b.query(
      "update acervo.fonte set obra_protegida = true, tipo_texto = 'ficha' where id = $1",
      [f.fonteId],
    );
    const resultado = virar.then(
      () => "passou",
      (erro: { code?: string }) => erro.code,
    );
    await esperarBloqueio(pidB);
    await a.query("commit");
    expect(await resultado).toBe("23514");
    expect(await paragrafosProibidos()).toBe(0);
  });

  it("virar protegida (ainda sem commit) e inserir parágrafo em paralelo: a inserção espera e falha", async () => {
    const f = await criarFonte("carga", "integral", false);
    await b.query("begin");
    await b.query(
      "update acervo.fonte set obra_protegida = true, tipo_texto = 'ficha' where id = $1",
      [f.fonteId],
    );
    const pidA = await pidDe(a);
    const inserir = paragrafo(a, f.secaoId).then(
      () => "passou",
      (erro: { code?: string }) => erro.code,
    );
    await esperarBloqueio(pidA);
    await b.query("commit");
    expect(await inserir).toBe("23514");
    expect(await paragrafosProibidos()).toBe(0);
  });

  it("inserir parágrafo (sem commit) e mover a seção para Fonte protegida em paralelo: a mudança espera e falha", async () => {
    const livre = await criarFonte("carga", "integral", false);
    const protegida = await criarFonte("carga", "ficha", true);
    await a.query("begin");
    await paragrafo(a, livre.secaoId);
    const pidB = await pidDe(b);
    const mover = b
      .query(
        "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
        [protegida.fonteId, livre.secaoId],
      )
      .then(
        () => "passou",
        (erro: { code?: string }) => erro.code,
      );
    await esperarBloqueio(pidB);
    await a.query("commit");
    expect(await mover).toBe("23514");
    expect(await paragrafosProibidos()).toBe(0);
  });

  it("mover a seção para Fonte protegida (sem commit) e inserir parágrafo em paralelo: a inserção espera e falha", async () => {
    const livre = await criarFonte("carga", "integral", false);
    const protegida = await criarFonte("carga", "ficha", true);
    await b.query("begin");
    await b.query(
      "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
      [protegida.fonteId, livre.secaoId],
    );
    const pidA = await pidDe(a);
    const inserir = paragrafo(a, livre.secaoId).then(
      () => "passou",
      (erro: { code?: string }) => erro.code,
    );
    await esperarBloqueio(pidA);
    await b.query("commit");
    expect(await inserir).toBe("23514");
    expect(await paragrafosProibidos()).toBe(0);
  });

  it("controle positivo: duas inserções de parágrafo na mesma Fonte integral não se bloqueiam", async () => {
    const f = await criarFonte("carga", "integral", false);
    await a.query("begin");
    await paragrafo(a, f.secaoId, "1");
    await expect(
      b.query(
        "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ($1, $2, 2, 'Outro.', '2')",
        [`${f.secaoId}#2`, f.secaoId],
      ),
    ).resolves.toBeDefined();
    await a.query("commit");
  });
});

const NIVEIS = ["repeatable read", "serializable"] as const;

describe.skipIf(emNeon())(
  "ACER-09: a escrita só vale em READ COMMITTED (a checagem de outra linha não enxerga o que ainda não era visível ao snapshot)",
  () => {
    let a: pg.Client;
    let b: pg.Client;

    beforeAll(async () => {
      if (emNeon()) return;
      a = await cliente("carga");
      b = await cliente("carga");
    });

    afterAll(async () => {
      for (const c of [a, b]) await c?.end().catch(() => {});
    });

    const MOVER =
      "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2";
    const VIRAR =
      "update acervo.fonte set obra_protegida = true, tipo_texto = 'ficha' where id = $1";

    /** Roda a tentativa de A (snapshot já fixado) e devolve o código do erro, ou "passou". Sempre desfaz A. */
    const tentar = async (c: pg.Client, sql: string, params: unknown[]): Promise<string> => {
      try {
        await c.query(sql, params);
        await c.query("commit");
        return "passou";
      } catch (erro) {
        await c.query("rollback").catch(() => {});
        return (erro as { code?: string }).code ?? "sem-codigo";
      }
    };

    it.each(NIVEIS)(
      "%s: A lê a seção vazia, B insere parágrafo e confirma, A move a seção para Fonte protegida: termina em erro",
      async (nivel) => {
        const livre = await criarFonte("carga", "integral", false);
        const protegida = await criarFonte("carga", "ficha", true);
        await a.query(`begin isolation level ${nivel}`);
        await a.query("select count(*) from acervo.fonte_paragrafo where secao_id = $1", [
          livre.secaoId,
        ]);
        await paragrafo(b, livre.secaoId);
        const r = await tentar(a, MOVER, [protegida.fonteId, livre.secaoId]);
        expect(r).not.toBe("passou");
        expect(await paragrafosProibidos()).toBe(0);
      },
    );

    it.each(NIVEIS)(
      "%s: A lê a Fonte sem parágrafo, B insere parágrafo e confirma, A vira a Fonte protegida: termina em erro",
      async (nivel) => {
        const f = await criarFonte("carga", "integral", false);
        await a.query(`begin isolation level ${nivel}`);
        await a.query(
          "select count(*) from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id where s.fonte_id = $1",
          [f.fonteId],
        );
        await paragrafo(b, f.secaoId);
        const r = await tentar(a, VIRAR, [f.fonteId]);
        expect(r).not.toBe("passou");
        expect(await paragrafosProibidos()).toBe(0);
      },
    );

    it.each(NIVEIS)(
      "%s: A lê a Fonte integral, B a vira protegida e confirma, A insere parágrafo: termina em erro",
      async (nivel) => {
        const f = await criarFonte("carga", "integral", false);
        await a.query(`begin isolation level ${nivel}`);
        await a.query("select obra_protegida from acervo.fonte where id = $1", [f.fonteId]);
        await b.query(VIRAR, [f.fonteId]);
        const r = await tentar(
          a,
          "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ($1, $2, 1, 'Texto.', '1')",
          [`${f.secaoId}#1`, f.secaoId],
        );
        expect(r).not.toBe("passou");
        expect(await paragrafosProibidos()).toBe(0);
      },
    );

    it.each(NIVEIS)(
      "%s: A lê a seção, B a move para Fonte protegida e confirma, A insere parágrafo na seção: termina em erro",
      async (nivel) => {
        const livre = await criarFonte("carga", "integral", false);
        const protegida = await criarFonte("carga", "ficha", true);
        await a.query(`begin isolation level ${nivel}`);
        await a.query("select fonte_id from acervo.fonte_secao where id = $1", [livre.secaoId]);
        await b.query(MOVER, [protegida.fonteId, livre.secaoId]);
        const r = await tentar(
          a,
          "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ($1, $2, 1, 'Texto.', '1')",
          [`${livre.secaoId}#1`, livre.secaoId],
        );
        expect(r).not.toBe("passou");
        expect(await paragrafosProibidos()).toBe(0);
      },
    );

    it.each(NIVEIS)(
      "%s: A lê a Fonte de destino integral, B a vira protegida e confirma, A move uma seção com parágrafo para ela: termina em erro",
      async (nivel) => {
        const origem = await criarFonte("carga", "integral", false);
        await paragrafo(b, origem.secaoId);
        const destino = await criarFonte("carga", "integral", false);
        await a.query(`begin isolation level ${nivel}`);
        await a.query("select obra_protegida from acervo.fonte where id = $1", [destino.fonteId]);
        await b.query(VIRAR, [destino.fonteId]);
        const r = await tentar(a, MOVER, [destino.fonteId, origem.secaoId]);
        expect(r).not.toBe("passou");
        expect(await paragrafosProibidos()).toBe(0);
      },
    );

    it("a recusa por isolamento diz o porquê (0A000)", async () => {
      const f = await criarFonte("carga", "integral", false);
      await a.query("begin isolation level repeatable read");
      const erro = await a
        .query(
          "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ($1, $2, 1, 'Texto.', '1')",
          [`${f.secaoId}#1`, f.secaoId],
        )
        .then(
          () => null,
          (e: { code?: string; message?: string }) => e,
        );
      await a.query("rollback");
      expect(erro?.code).toBe("0A000");
      expect(erro?.message).toMatch(/READ COMMITTED/);
    });

    it("controle positivo: READ COMMITTED explícito aceita o parágrafo, a mudança de Fonte entre integrais e a corrida resolvida por espera", async () => {
      const f = await criarFonte("carga", "integral", false);
      const g = await criarFonte("carga", "integral", false);
      await a.query("begin isolation level read committed");
      await paragrafo(a, f.secaoId);
      await a.query(
        "update acervo.fonte_secao set fonte_id = $1, ordem = 2, slug = 'movida' where id = $2",
        [g.fonteId, f.secaoId],
      );
      await a.query("commit");
      const r = await superusuario.query("select fonte_id from acervo.fonte_secao where id = $1", [
        f.secaoId,
      ]);
      expect(r.rows).toEqual([{ fonte_id: g.fonteId }]);
      expect(await paragrafosProibidos()).toBe(0);
    });

    it("controle positivo: transação em REPEATABLE READ que não escreve texto continua funcionando (leitura e mudança de título)", async () => {
      const f = await criarFonte("carga", "integral", false);
      await a.query("begin isolation level repeatable read");
      await a.query("select count(*) from acervo.fonte_paragrafo");
      await a.query("update acervo.fonte set titulo = 'Novo título' where id = $1", [f.fonteId]);
      await a.query("commit");
    });

    it("corrida em READ COMMITTED: virar protegida (sem commit) e mover seção com parágrafo para ela em paralelo: o movimento espera e falha", async () => {
      const origem = await criarFonte("carga", "integral", false);
      await paragrafo(b, origem.secaoId);
      const destino = await criarFonte("carga", "integral", false);
      await a.query("begin");
      await a.query(VIRAR, [destino.fonteId]);
      const pidB = await pidDe(b);
      const mover = b.query(MOVER, [destino.fonteId, origem.secaoId]).then(
        () => "passou",
        (erro: { code?: string }) => erro.code,
      );
      await esperarBloqueio(pidB);
      await a.query("commit");
      expect(await mover).toBe("23514");
      expect(await paragrafosProibidos()).toBe(0);
    });

    it("corrida em READ COMMITTED: mover seção com parágrafo para a Fonte (sem commit) e virar a Fonte protegida em paralelo: a mudança espera e falha", async () => {
      const origem = await criarFonte("carga", "integral", false);
      await paragrafo(b, origem.secaoId);
      const destino = await criarFonte("carga", "integral", false);
      await a.query("begin");
      await a.query(MOVER, [destino.fonteId, origem.secaoId]);
      const pidB = await pidDe(b);
      const virar = b.query(VIRAR, [destino.fonteId]).then(
        () => "passou",
        (erro: { code?: string }) => erro.code,
      );
      await esperarBloqueio(pidB);
      await a.query("commit");
      expect(await virar).toBe("23514");
      expect(await paragrafosProibidos()).toBe(0);
    });
  },
);

describe.skipIf(emNeon())("a migração 0019 é idempotente", () => {
  it("aplicada de novo, sem erro, e a recusa por isolamento continua valendo", async () => {
    const arquivo = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "db",
      "migrations",
      "0019_acervo_integridade_concorrencia.sql",
    );
    const texto = readFileSync(arquivo, "utf8");
    for (let i = 0; i < 2; i++) {
      await migra.query("begin");
      await migra.query(texto);
      await migra.query("commit");
    }
    const f = await criarFonte("migra", "integral", false);
    await migra.query("begin isolation level repeatable read");
    await expect(paragrafo(migra, f.secaoId)).rejects.toMatchObject({ code: "0A000" });
    await migra.query("rollback");
    await expect(paragrafo(migra, f.secaoId)).resolves.toBeDefined();
  });
});
