import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { comAdmin, fabricarComAdmin } from "@/db/com-admin";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";

// Visibilidade da ficha (ACER-07, D-02, D-03): uma ficha recém-carregada é rascunho; ninguém a lê,
// além de um Admin com segundo fator na geração atual. Cada papel usa a PRÓPRIA conexão. Cria dado de
// teste, então usa um banco descartável SÓ deste arquivo e não roda no Neon.

const emNeon = () => inject("alvoBanco") === "neon";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SEM_SESSAO = "00000000-0000-4000-8000-0000000000aa";

let banco: BancoDeExecucao | undefined;
let superusuario: pg.Client;
let carga: pg.Client;
let migra: pg.Client;
let assistente: pg.Client;
let fichaId: string;
let integralId: string;
const sessoes = {} as Record<CasoDeSessao, string>;

async function cliente(papel: "carga" | "migra" | "assistente" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

/** Linhas que o jnf_app lê dentro de uma transação que carrega a sessão pedida (ou nenhuma). */
async function leituraDoApp(sessao: string | null) {
  const c = await cliente("app");
  try {
    await c.query("begin");
    if (sessao !== null) await c.query("select set_config('app.sessao_admin', $1, true)", [sessao]);
    const n = async (tabela: string) =>
      Number((await c.query(`select count(*)::int as n from ${tabela}`)).rows[0].n);
    const r = {
      fonteFicha: Number(
        (await c.query("select count(*)::int as n from acervo.fonte where tipo_texto = 'ficha'"))
          .rows[0].n,
      ),
      ficha: await n("acervo.ficha"),
      item: await n("acervo.ficha_item"),
    };
    await c.query("commit");
    return r;
  } finally {
    await c.end().catch(() => {});
  }
}

async function leituraDoAssistente() {
  const n = async (tabela: string) =>
    Number((await assistente.query(`select count(*)::int as n from ${tabela}`)).rows[0].n);
  return {
    fonteFicha: Number(
      (
        await assistente.query(
          "select count(*)::int as n from acervo.fonte where tipo_texto = 'ficha'",
        )
      ).rows[0].n,
    ),
    ficha: await n("acervo.ficha"),
    item: await n("acervo.ficha_item"),
  };
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
  assistente = await cliente("assistente");

  for (const caso of [
    "admin-com-segundo-fator",
    "admin-sem-segundo-fator",
    "estudante",
    "geracao-antiga",
    "sessao-vencida",
  ] as const) {
    sessoes[caso] = (await criarSessaoDeTeste(superusuario, caso)).sessaoId;
  }

  // O rascunho nasce COMO O PAPEL DE CARGA: Fonte de ficha, ficha e um item.
  const fonte = await carga.query<{ id: string }>(
    `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, obra_protegida, publicada)
     values ('obra-de-teste', 'Obra de Teste', 'Autora de Teste', 'academica', 'ficha', 'en', true, false)
     returning id`,
  );
  fichaId = (fonte.rows[0] as { id: string }).id;
  await carga.query(
    `insert into acervo.ficha (fonte_id, edicao_consultada, ano, editora, tese_pt, idioma_trechos, conteudo_hash)
     values ($1, '1ª edição de teste', 2001, 'Editora de Teste', 'Tese de teste.', 'en', $2)`,
    [fichaId, HASH_A],
  );
  await carga.query(
    `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim, confianca, conteudo_hash)
     values ('obra-de-teste/argumento-1', $1, 'argumento', 1, 'Argumento de teste.', 10, 10, 'media', $2)`,
    [fichaId, HASH_B],
  );

  // Controle positivo: uma Fonte de texto integral publicada.
  const integral = await carga.query<{ id: string }>(
    `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, licenca, origem_url, origem_nome, publicada)
     values ('texto-integral-de-teste', 'Texto de Teste', 'primaria', 'integral', 'en', 'dominio-publico',
             'https://exemplo.invalid/texto', 'Origem de Teste', true) returning id`,
  );
  integralId = (integral.rows[0] as { id: string }).id;
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, migra, assistente, superusuario]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("ficha em rascunho", () => {
  it("o rascunho existe para o dono e para a carga (controle: a leitura enxerga dado)", async () => {
    const dono = await migra.query("select count(*)::int as n from acervo.ficha");
    expect(dono.rows[0].n).toBe(1);
    const daCarga = await carga.query("select count(*)::int as n from acervo.ficha_item");
    expect(daCarga.rows[0].n).toBe(1);
  });

  it("jnf_app sem sessão de Admin lê 0 linhas de Fonte de ficha, ficha e item", async () => {
    expect(await leituraDoApp(null)).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
  });

  it("jnf_assistente lê 0 linhas de rascunho", async () => {
    expect(await leituraDoAssistente()).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
  });

  it.each([
    ["sessão de Estudante, mesmo com marca de segundo fator", "estudante"],
    ["Admin sem segundo fator", "admin-sem-segundo-fator"],
    ["marca de uma geração que a recuperação já substituiu", "geracao-antiga"],
    ["sessão vencida", "sessao-vencida"],
  ] as const)("recusa: %s", async (_rotulo, caso) => {
    expect(await leituraDoApp(sessoes[caso])).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
  });

  it("recusa: identificador de sessão que não existe", async () => {
    expect(await leituraDoApp(SEM_SESSAO)).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
  });

  it("controle positivo: Admin com segundo fator na geração atual lê o rascunho", async () => {
    expect(await leituraDoApp(sessoes["admin-com-segundo-fator"])).toEqual({
      fonteFicha: 1,
      ficha: 1,
      item: 1,
    });
  });

  it("controle positivo pela porta comAdmin (transação de leitura e escrita)", async () => {
    const lido = await comAdmin(sessoes["admin-com-segundo-fator"], async (tx) => {
      const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from acervo.ficha`);
      const modo = await tx.execute<{ somente_leitura: string }>(
        sql`select current_setting('transaction_read_only') as somente_leitura`,
      );
      return { n: r.rows[0]?.n, somenteLeitura: modo.rows[0]?.somente_leitura };
    });
    expect(lido).toEqual({ n: 1, somenteLeitura: "off" });
    // Sem a sessão de Admin, a mesma porta não vê nada.
    const semMfa = await comAdmin(sessoes["admin-sem-segundo-fator"], async (tx) => {
      const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from acervo.ficha`);
      return r.rows[0]?.n;
    });
    expect(semMfa).toBe(0);
  });

  it("a porta comAdmin recusa texto que não é uuid, antes de qualquer SQL", async () => {
    let chamadas = 0;
    const porta = fabricarComAdmin(
      () => ({
        transaction: (() => {
          chamadas++;
          throw new Error("não deveria abrir transação");
        }) as never,
      }),
      async () => {},
    );
    await expect(porta("'; drop table acervo.ficha; --", async () => 1)).rejects.toThrow();
    expect(chamadas).toBe(0);
  });

  it("o valor de app.sessao_admin não vaza para a próxima transação da mesma conexão", async () => {
    const c = await cliente("app");
    try {
      await c.query("begin");
      await c.query("select set_config('app.sessao_admin', $1, true)", [
        sessoes["admin-com-segundo-fator"],
      ]);
      await c.query("commit");
      const depois = await c.query("select count(*)::int as n from acervo.ficha");
      expect(depois.rows[0].n).toBe(0);
    } finally {
      await c.end().catch(() => {});
    }
  });
});

describe.skipIf(emNeon())("ficha com evidência de verificação (amarrada ao hash)", () => {
  it("com ficha_hash igual ao conteudo_hash, jnf_app e jnf_assistente leem a ficha; com hash diferente, 0", async () => {
    // O hash do conteúdo é calculado pelo banco (0018): a carga não o escolhe, então o teste lê o valor vigente.
    const hashAtual = (
      await migra.query<{ conteudo_hash: string }>(
        "select conteudo_hash from acervo.ficha where fonte_id = $1",
        [fichaId],
      )
    ).rows[0]?.conteudo_hash as string;
    expect(hashAtual).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAtual).not.toBe(HASH_A);

    // A evidência é inserida pelo DONO do esquema (nenhum outro papel tem escrita).
    await migra.query(
      "insert into acervo.verificacao_ficha (ficha_id, ficha_hash) values ($1, $2)",
      [fichaId, HASH_B],
    );
    // Hash diferente do conteúdo atual: continua rascunho.
    expect(await leituraDoApp(null)).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
    expect(await leituraDoAssistente()).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });

    // Hash igual: lida por jnf_app (sem sessão alguma) e por jnf_assistente.
    await migra.query("update acervo.verificacao_ficha set ficha_hash = $2 where ficha_id = $1", [
      fichaId,
      hashAtual,
    ]);
    expect(await leituraDoApp(null)).toEqual({ fonteFicha: 1, ficha: 1, item: 1 });
    expect(await leituraDoAssistente()).toEqual({ fonteFicha: 1, ficha: 1, item: 1 });

    // O conteúdo muda (o banco recalcula o hash): a verificação deixa de valer, em silêncio.
    await carga.query("update acervo.ficha set tese_pt = 'Tese adulterada.' where fonte_id = $1", [
      fichaId,
    ]);
    expect(await leituraDoApp(null)).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
    expect(await leituraDoAssistente()).toEqual({ fonteFicha: 0, ficha: 0, item: 0 });
    // Controle: o Admin com segundo fator continua lendo o rascunho.
    expect(await leituraDoApp(sessoes["admin-com-segundo-fator"])).toEqual({
      fonteFicha: 1,
      ficha: 1,
      item: 1,
    });
    // Desfeita a mudança, o hash volta a ser o da evidência (o hash é função do conteúdo).
    await carga.query("update acervo.ficha set tese_pt = 'Tese de teste.' where fonte_id = $1", [
      fichaId,
    ]);
    expect(await leituraDoApp(null)).toEqual({ fonteFicha: 1, ficha: 1, item: 1 });
  });

  it("o papel de carga e o papel do aplicativo não gravam evidência", async () => {
    const tentativas: [string, string, unknown[]][] = [
      [
        "acervo.verificacao_ficha",
        "insert into acervo.verificacao_ficha (ficha_id, ficha_hash) values ($1, $2)",
        [fichaId, HASH_A],
      ],
      [
        "acervo.conferencia_item",
        "insert into acervo.conferencia_item (item_id, item_hash) values ($1, $2)",
        ["obra-de-teste/argumento-1", HASH_A],
      ],
      [
        "admin.registro_verificacao",
        "insert into admin.registro_verificacao (acao, alvo, hash) values ('verificar-ficha', $1, $2)",
        ["obra-de-teste", HASH_A],
      ],
    ];
    for (const [tabela, comando, params] of tentativas) {
      // A carga nem enxerga o esquema admin: 42501 também (sem USAGE no esquema).
      await expect(carga.query(comando, params), `carga em ${tabela}`).rejects.toMatchObject({
        code: "42501",
      });
      const app = await cliente("app");
      try {
        await expect(app.query(comando, params), `app em ${tabela}`).rejects.toMatchObject({
          code: "42501",
        });
        // update e delete também, nas duas tabelas de evidência do Acervo.
        if (tabela.startsWith("acervo.")) {
          await expect(app.query(`delete from ${tabela}`)).rejects.toMatchObject({ code: "42501" });
        }
      } finally {
        await app.end().catch(() => {});
      }
    }
    // Controle positivo: o dono do esquema grava (a recusa vem do privilégio, não de dado errado).
    await migra.query(
      "insert into acervo.conferencia_item (item_id, item_hash) values ('obra-de-teste/argumento-1', $1)",
      [HASH_B],
    );
    const lida = await migra.query("select count(*)::int as n from acervo.conferencia_item");
    expect(lida.rows[0].n).toBe(1);
  });
});

describe.skipIf(emNeon())("Fonte de texto integral e privilégio da função", () => {
  it("controle positivo: Fonte integral publicada continua legível por jnf_app e jnf_assistente", async () => {
    const app = await cliente("app");
    try {
      const doApp = await app.query(
        "select id from acervo.fonte where slug = 'texto-integral-de-teste'",
      );
      expect(doApp.rows.map((l) => l.id)).toEqual([integralId]);
    } finally {
      await app.end().catch(() => {});
    }
    const doAssistente = await assistente.query(
      "select id from acervo.fonte where slug = 'texto-integral-de-teste'",
    );
    expect(doAssistente.rows.map((l) => l.id)).toEqual([integralId]);
  });

  it("Fonte integral NÃO publicada some para jnf_app e jnf_assistente, e continua para a carga", async () => {
    await carga.query("update acervo.fonte set publicada = false where id = $1", [integralId]);
    try {
      const app = await cliente("app");
      try {
        const r = await app.query("select count(*)::int as n from acervo.fonte where id = $1", [
          integralId,
        ]);
        expect(r.rows[0].n).toBe(0);
      } finally {
        await app.end().catch(() => {});
      }
      const a = await assistente.query(
        "select count(*)::int as n from acervo.fonte where id = $1",
        [integralId],
      );
      expect(a.rows[0].n).toBe(0);
      const c = await carga.query("select count(*)::int as n from acervo.fonte where id = $1", [
        integralId,
      ]);
      expect(c.rows[0].n).toBe(1);
    } finally {
      await carga.query("update acervo.fonte set publicada = true where id = $1", [integralId]);
    }
  });

  it("exigir_admin_mfa: execute só para jnf_app (nunca carga nem assistente)", async () => {
    const r = await superusuario.query<{ papel: string; pode: boolean }>(
      `select p as papel, has_function_privilege(p, 'acervo.exigir_admin_mfa(uuid)', 'execute') as pode
         from unnest(array['jnf_app','jnf_carga','jnf_assistente']) as p`,
    );
    const por = Object.fromEntries(r.rows.map((l) => [l.papel, l.pode]));
    expect(por).toEqual({ jnf_app: true, jnf_carga: false, jnf_assistente: false });
    const publico = await superusuario.query<{ pode: boolean }>(
      `select exists (
         select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         where p.oid = 'acervo.exigir_admin_mfa(uuid)'::regprocedure and a.grantee = 0
           and a.privilege_type = 'EXECUTE') as pode`,
    );
    expect(publico.rows[0]?.pode).toBe(false);
  });

  it("exigir_admin_mfa devolve o usuário só para Admin com segundo fator vivo na geração atual", async () => {
    const chamar = async (sessao: string) =>
      (await superusuario.query("select acervo.exigir_admin_mfa($1::uuid) as u", [sessao])).rows[0]
        .u;
    const usuario = (
      await superusuario.query<{ user_id: string }>(
        "select user_id from auth.session where id = $1",
        [sessoes["admin-com-segundo-fator"]],
      )
    ).rows[0]?.user_id;
    expect(await chamar(sessoes["admin-com-segundo-fator"])).toBe(usuario);
    for (const caso of [
      "admin-sem-segundo-fator",
      "estudante",
      "geracao-antiga",
      "sessao-vencida",
    ] as const)
      expect(await chamar(sessoes[caso]), caso).toBeNull();
    expect(await chamar(SEM_SESSAO)).toBeNull();
  });
});

describe.skipIf(emNeon())("a migração 0017 é idempotente", () => {
  it("aplicada de novo pelo dono, sem erro e sem mudar o que a política deixa ler", async () => {
    const arquivo = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "db",
      "migrations",
      "0017_acervo_ficha.sql",
    );
    const texto = readFileSync(arquivo, "utf8");
    const antes = await leituraDoApp(sessoes["admin-com-segundo-fator"]);
    await migra.query("begin");
    await migra.query(texto);
    await migra.query("commit");
    await migra.query("begin");
    await migra.query(texto);
    await migra.query("commit");
    expect(await leituraDoApp(sessoes["admin-com-segundo-fator"])).toEqual(antes);
    // Os privilégios revogados continuam revogados depois de reaplicar.
    const r = await superusuario.query<{ pode: boolean }>(
      "select has_table_privilege('jnf_carga', 'acervo.verificacao_ficha', 'insert') as pode",
    );
    expect(r.rows[0]?.pode).toBe(false);
  });
});
