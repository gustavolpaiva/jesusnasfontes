import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { ErroDeBanco } from "@/db/erro-banco";
import {
  ConteudoMudou,
  EdicaoNaoConfirmada,
  FaltamPaginas,
  SegundoFatorVencido,
} from "@/modules/acervo/erros";
import { type FichaYaml, interpretarFichaYaml } from "@/modules/acervo/schemas";
import { conferirItem, verificarFicha } from "@/modules/acervo/verificacao";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";
import { verificarFichaParaTeste } from "../../support/verificar-ficha-teste";

// Verificação da ficha (ACER-07, D-02, D-03, D-05): as duas únicas portas que gravam evidência, por função do banco que
// reexige a sessão de um Admin com segundo fator. Cada papel usa a PRÓPRIA conexão; cada caso negativo tem o positivo
// no mesmo arquivo. Cria dado de teste: banco descartável SÓ deste arquivo, fora do Neon.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas");
const emNeon = () => inject("alvoBanco") === "neon";
const SEM_SESSAO = "00000000-0000-4000-8000-0000000000aa";
const HASH_FALSO = "f".repeat(64);

let banco: BancoDeExecucao | undefined;
let envDoBanco: Record<string, string> = {};
let superusuario: pg.Client;
let carga: pg.Client;
let migra: pg.Client;
let assistente: pg.Client;
const sessoes = {} as Record<CasoDeSessao, string>;

async function cliente(papel: "carga" | "migra" | "assistente" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

const yamlDe = (nome: string) => readFileSync(path.join(PASTA_FIXTURES, nome), "utf8");
let n = 0;

/** Carrega uma ficha de teste pelo carregador real (rascunho), com slug próprio. */
async function carregarFicha(opcoes: { edicaoPendente?: boolean } = {}): Promise<{
  slug: string;
  fichaId: string;
  itens: string[];
  ficha: FichaYaml;
}> {
  n++;
  const slug = `ficha-verificavel-${n}`;
  const yaml = yamlDe(
    opcoes.edicaoPendente ? "obra-de-teste-edicao-pendente.yaml" : "obra-de-teste.yaml",
  ).replace(/^slug: .*$/m, `slug: ${slug}`);
  const ficha = interpretarFichaYaml(yaml, `${slug}.yaml`);
  await carregarRascunhos([ficha], { cliente: carga });
  const id = await migra.query<{ id: string }>("select id from acervo.fonte where slug = $1", [
    slug,
  ]);
  const itens = await migra.query<{ id: string }>(
    "select id from acervo.ficha_item where ficha_id = $1 order by tipo, ordem",
    [(id.rows[0] as { id: string }).id],
  );
  return {
    slug,
    fichaId: (id.rows[0] as { id: string }).id,
    itens: itens.rows.map((i) => i.id),
    ficha,
  };
}

const hashDoItemNoBanco = async (id: string): Promise<string> =>
  (
    (await migra.query("select conteudo_hash from acervo.ficha_item where id = $1", [id]))
      .rows[0] as { conteudo_hash: string }
  ).conteudo_hash;

const hashDaFichaNoBanco = async (fichaId: string): Promise<string> =>
  (
    (await migra.query("select conteudo_hash from acervo.ficha where fonte_id = $1", [fichaId]))
      .rows[0] as { conteudo_hash: string }
  ).conteudo_hash;

const contar = async (consulta: string, params: unknown[] = []): Promise<number> =>
  Number(((await migra.query(consulta, params)).rows[0] as { n: number }).n);

const conferenciasDe = (fichaId: string) =>
  contar(
    `select count(*)::int as n from acervo.conferencia_item c
       join acervo.ficha_item i on i.id = c.item_id where i.ficha_id = $1`,
    [fichaId],
  );
const verificacoesDe = (fichaId: string) =>
  contar("select count(*)::int as n from acervo.verificacao_ficha where ficha_id = $1", [fichaId]);
const registrosDe = (alvo: string) =>
  contar("select count(*)::int as n from admin.registro_verificacao where alvo = $1", [alvo]);

/** O que um leitor jnf_app SEM sessão de Admin (o Estudante) vê da ficha. */
async function leituraDoEstudante(slug: string) {
  const app = await cliente("app");
  try {
    const fonte = await app.query("select count(*)::int as n from acervo.fonte where slug = $1", [
      slug,
    ]);
    const item = await app.query(
      "select count(*)::int as n from acervo.ficha_item where id like $1",
      [`${slug}/%`],
    );
    return { fonte: fonte.rows[0].n as number, item: item.rows[0].n as number };
  } finally {
    await app.end().catch(() => {});
  }
}

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

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  envDoBanco = preparado.env;
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
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, migra, assistente, superusuario]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("privilégio de execução das funções de verificação", () => {
  const ASSINATURAS = [
    "acervo.conferir_item(uuid, text, text)",
    "acervo.verificar_ficha(uuid, uuid, text)",
  ];

  it("execute só para jnf_app: nunca carga, assistente nem o público", async () => {
    for (const assinatura of ASSINATURAS) {
      const r = await superusuario.query<{ papel: string; pode: boolean }>(
        `select p as papel, has_function_privilege(p, $1, 'execute') as pode
           from unnest(array['jnf_app','jnf_carga','jnf_assistente']) as p`,
        [assinatura],
      );
      expect(Object.fromEntries(r.rows.map((l) => [l.papel, l.pode])), assinatura).toEqual({
        jnf_app: true,
        jnf_carga: false,
        jnf_assistente: false,
      });
      const publico = await superusuario.query<{ pode: boolean }>(
        `select exists (
           select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           where p.oid = $1::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as pode`,
        [assinatura],
      );
      expect(publico.rows[0]?.pode, `${assinatura}: público`).toBe(false);
      const definidora = await superusuario.query<{ definer: boolean; dono: string }>(
        `select prosecdef as definer, pg_get_userbyid(proowner) as dono
           from pg_proc where oid = $1::regprocedure`,
        [assinatura],
      );
      expect(definidora.rows[0]).toEqual({ definer: true, dono: "jnf_migra" });
    }
  });

  it("jnf_carga e jnf_assistente chamando as funções: recusado por falta de privilégio (42501)", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const hash = await hashDoItemNoBanco(item);
    for (const [papel, c] of [
      ["jnf_carga", carga],
      ["jnf_assistente", assistente],
    ] as const) {
      await expect(
        c.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessoes["admin-com-segundo-fator"],
          item,
          hash,
        ]),
        `${papel} conferir_item`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        c.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessoes["admin-com-segundo-fator"],
          f.fichaId,
          await hashDaFichaNoBanco(f.fichaId),
        ]),
        `${papel} verificar_ficha`,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await conferenciasDe(f.fichaId)).toBe(0);
    expect(await verificacoesDe(f.fichaId)).toBe(0);
  });

  it("jnf_app não grava evidência nem registro por SQL direto", async () => {
    const f = await carregarFicha();
    const app = await cliente("app");
    try {
      for (const [rotulo, comando, params] of [
        [
          "acervo.conferencia_item",
          "insert into acervo.conferencia_item (item_id, item_hash) values ($1, $2)",
          [f.itens[0], HASH_FALSO],
        ],
        [
          "acervo.verificacao_ficha",
          "insert into acervo.verificacao_ficha (ficha_id, ficha_hash) values ($1, $2)",
          [f.fichaId, HASH_FALSO],
        ],
        [
          "admin.registro_verificacao",
          "insert into admin.registro_verificacao (acao, alvo, hash) values ('verificar-ficha', $1, $2)",
          [f.slug, HASH_FALSO],
        ],
      ] as const) {
        await expect(app.query(comando, [...params]), rotulo).rejects.toMatchObject({
          code: "42501",
        });
      }
      // update e delete também.
      for (const tabela of [
        "acervo.conferencia_item",
        "acervo.verificacao_ficha",
        "admin.registro_verificacao",
      ]) {
        await expect(app.query(`delete from ${tabela}`), `delete ${tabela}`).rejects.toMatchObject({
          code: "42501",
        });
      }
    } finally {
      await app.end().catch(() => {});
    }
  });
});

describe.skipIf(emNeon())("sessão: só Admin com segundo fator grava (T-02-17)", () => {
  it.each([
    ["sessão de Estudante, mesmo com marca de segundo fator", "estudante"],
    ["Admin sem segundo fator", "admin-sem-segundo-fator"],
    ["marca de uma geração que a recuperação já substituiu", "geracao-antiga"],
    ["sessão vencida", "sessao-vencida"],
  ] as const)("recusa com 42501 e nada é gravado: %s", async (_rotulo, caso) => {
    const f = await carregarFicha();
    const app = await cliente("app");
    try {
      await expect(
        app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessoes[caso],
          f.itens[0],
          await hashDoItemNoBanco(f.itens[0] as string),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessoes[caso],
          f.fichaId,
          await hashDaFichaNoBanco(f.fichaId),
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end().catch(() => {});
    }
    expect(await conferenciasDe(f.fichaId)).toBe(0);
    expect(await verificacoesDe(f.fichaId)).toBe(0);
    expect(await registrosDe(f.itens[0] as string)).toBe(0);
  });

  it("recusa com 42501: identificador de sessão que não existe, e sessão nula", async () => {
    const f = await carregarFicha();
    const app = await cliente("app");
    try {
      for (const sessao of [SEM_SESSAO, null]) {
        await expect(
          app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
            sessao,
            f.itens[0],
            await hashDoItemNoBanco(f.itens[0] as string),
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await app.end().catch(() => {});
    }
    expect(await conferenciasDe(f.fichaId)).toBe(0);
  });

  it("controle positivo: Admin com segundo fator confere com o hash atual e a conferência fica gravada", async () => {
    const f = await carregarFicha();
    const item = f.itens[0] as string;
    const hash = await hashDoItemNoBanco(item);
    const app = await cliente("app");
    try {
      await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
        sessoes["admin-com-segundo-fator"],
        item,
        hash,
      ]);
    } finally {
      await app.end().catch(() => {});
    }
    expect(await conferenciasDe(f.fichaId)).toBe(1);
    const linha = (
      await migra.query("select item_hash from acervo.conferencia_item where item_id = $1", [item])
    ).rows[0];
    expect(linha.item_hash).toBe(hash);
    expect(await registrosDe(item)).toBe(1);
  });

  it("conferir_item com hash velho ou item inexistente recusa com 40001", async () => {
    const f = await carregarFicha();
    const app = await cliente("app");
    try {
      await expect(
        app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessoes["admin-com-segundo-fator"],
          f.itens[0],
          HASH_FALSO,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
      await expect(
        app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessoes["admin-com-segundo-fator"],
          `${f.slug}/argumento-99`,
          HASH_FALSO,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await app.end().catch(() => {});
    }
    expect(await conferenciasDe(f.fichaId)).toBe(0);
  });

  it("as duas funções recusam fora de READ COMMITTED (0A000), com sessão válida", async () => {
    const f = await carregarFicha();
    const app = await cliente("app");
    try {
      for (const nivel of ["repeatable read", "serializable"]) {
        await app.query(`begin isolation level ${nivel}`);
        await expect(
          app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
            sessoes["admin-com-segundo-fator"],
            f.itens[0],
            await hashDoItemNoBanco(f.itens[0] as string),
          ]),
        ).rejects.toMatchObject({ code: "0A000" });
        await app.query("rollback");
        await app.query(`begin isolation level ${nivel}`);
        await expect(
          app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
            sessoes["admin-com-segundo-fator"],
            f.fichaId,
            await hashDaFichaNoBanco(f.fichaId),
          ]),
        ).rejects.toMatchObject({ code: "0A000" });
        await app.query("rollback");
      }
    } finally {
      await app.end().catch(() => {});
    }
    expect(await conferenciasDe(f.fichaId)).toBe(0);
    expect(await verificacoesDe(f.fichaId)).toBe(0);
  });
});

describe.skipIf(emNeon())("da ficha em rascunho à ficha que o Estudante lê (D-02)", () => {
  it("verificar_ficha recusa enquanto falta conferir página e diz quantas faltam (P0001)", async () => {
    const f = await carregarFicha();
    const sessao = sessoes["admin-com-segundo-fator"];
    const app = await cliente("app");
    try {
      const hashDaFicha = await hashDaFichaNoBanco(f.fichaId);
      const tentar = () =>
        app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessao,
          f.fichaId,
          hashDaFicha,
        ]);
      // Nenhuma conferida: faltam 3.
      await expect(tentar()).rejects.toMatchObject({ code: "P0001", constraint: "faltam_3" });
      // Duas conferidas: falta 1 (o controle de que a contagem anda).
      for (const item of f.itens.slice(0, 2)) {
        await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessao,
          item,
          await hashDoItemNoBanco(item),
        ]);
      }
      await expect(tentar()).rejects.toMatchObject({ code: "P0001", constraint: "faltam_1" });
      expect(await verificacoesDe(f.fichaId)).toBe(0);
      // A terceira conferência libera a verificação (controle positivo).
      const ultimo = f.itens[2] as string;
      await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
        sessao,
        ultimo,
        await hashDoItemNoBanco(ultimo),
      ]);
      await tentar();
    } finally {
      await app.end().catch(() => {});
    }
    expect(await verificacoesDe(f.fichaId)).toBe(1);
  });

  it("depois de conferir tudo e verificar, o leitor sem sessão de Admin lê a ficha e o item, e a evidência não tem pessoa", async () => {
    const f = await carregarFicha();
    // Antes: rascunho invisível ao Estudante.
    expect(await leituraDoEstudante(f.slug)).toEqual({ fonte: 0, item: 0 });
    await verificarFichaParaTeste(envDoBanco, f.slug);
    expect(await leituraDoEstudante(f.slug)).toEqual({ fonte: 1, item: 3 });

    // O Estudante lê a data da verificação e nenhuma coluna de pessoa.
    const app = await cliente("app");
    try {
      const r = await app.query("select * from acervo.verificacao_ficha where ficha_id = $1", [
        f.fichaId,
      ]);
      expect(r.rows).toHaveLength(1);
      expect(Object.keys(r.rows[0]).sort()).toEqual(["ficha_hash", "ficha_id", "verificada_em"]);
      expect(r.rows[0].verificada_em).toBeInstanceOf(Date);
    } finally {
      await app.end().catch(() => {});
    }
    // O Assistente também lê a ficha verificada (a política de leitura é a da evidência).
    const doAssistente = await assistente.query(
      "select count(*)::int as n from acervo.fonte where slug = $1",
      [f.slug],
    );
    expect(doAssistente.rows[0].n).toBe(1);
  });

  it("verificar_ficha com ficha_hash velho recusa com 40001 e nada é gravado", async () => {
    const g = await carregarFicha();
    const sessao = sessoes["admin-com-segundo-fator"];
    const app = await cliente("app");
    try {
      for (const item of g.itens) {
        await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessao,
          item,
          await hashDoItemNoBanco(item),
        ]);
      }
      await expect(
        app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessao,
          g.fichaId,
          HASH_FALSO,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
      // Ficha que não existe: também 40001.
      await expect(
        app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessao,
          SEM_SESSAO,
          HASH_FALSO,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
    } finally {
      await app.end().catch(() => {});
    }
    expect(await verificacoesDe(g.fichaId)).toBe(0);
    expect(await registrosDe(g.slug)).toBe(0);
  });

  it("verificar_ficha recusa (P0002) a ficha cuja edição consultada começa por 'A confirmar', mesmo com tudo conferido", async () => {
    const pendente = await carregarFicha({ edicaoPendente: true });
    const sessao = sessoes["admin-com-segundo-fator"];
    const app = await cliente("app");
    try {
      for (const item of pendente.itens) {
        await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
          sessao,
          item,
          await hashDoItemNoBanco(item),
        ]);
      }
      await expect(
        app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessao,
          pendente.fichaId,
          await hashDaFichaNoBanco(pendente.fichaId),
        ]),
      ).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await app.end().catch(() => {});
    }
    expect(await verificacoesDe(pendente.fichaId)).toBe(0);
    // Controle positivo: a mesma ficha com edição declarada verifica (cobertura do teste anterior), e a pendente
    // volta a verificar quando a edição é confirmada pela recarga.
    await carga.query(
      "update acervo.ficha set edicao_consultada = 'Primeira edição de teste, 2001' where fonte_id = $1",
      [pendente.fichaId],
    );
    await verificarFichaParaTeste(envDoBanco, pendente.slug);
    expect(await verificacoesDe(pendente.fichaId)).toBe(1);
  });
});

describe.skipIf(emNeon())(
  "a evidência nunca fica amarrada a conteúdo velho (corrida de duas conexões)",
  () => {
    // Cada caso: a ficha está com tudo conferido e pronta para verificar; uma segunda conexão muda o conteúdo.
    async function fichaProntaParaVerificar() {
      const f = await carregarFicha();
      const sessao = sessoes["admin-com-segundo-fator"];
      const app = await cliente("app");
      try {
        for (const item of f.itens) {
          await app.query("select acervo.conferir_item($1::uuid, $2, $3)", [
            sessao,
            item,
            await hashDoItemNoBanco(item),
          ]);
        }
      } finally {
        await app.end().catch(() => {});
      }
      return { f, sessao, hashVelho: await hashDaFichaNoBanco(f.fichaId) };
    }

    it.each([
      [
        "a tese da ficha",
        "update acervo.ficha set tese_pt = 'Tese mudada na corrida.' where fonte_id = $1",
      ],
      [
        "o texto de um item",
        "update acervo.ficha_item set texto_pt = 'Argumento mudado na corrida.' where ficha_id = $1 and tipo = 'argumento' and ordem = 1",
      ],
      [
        "o título da Fonte",
        "update acervo.fonte set titulo = 'Título mudado na corrida' where id = $1",
      ],
    ])(
      "mudar %s em curso (sem commit): a verificação espera, relê o hash novo e recusa com 40001",
      async (_rotulo, atualizacao) => {
        const { f, sessao, hashVelho } = await fichaProntaParaVerificar();
        const mudanca = await cliente("carga");
        const verificacao = await cliente("app");
        try {
          await mudanca.query("begin");
          await mudanca.query(atualizacao, [f.fichaId]);
          await verificacao.query("begin");
          const pid = await pidDe(verificacao);
          const tentativa = verificacao
            .query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
              sessao,
              f.fichaId,
              hashVelho,
            ])
            .then(
              () => ({ ok: true as const }),
              (erro: { code?: string }) => ({ ok: false as const, code: erro.code }),
            );
          await esperarBloqueio(pid);
          await mudanca.query("commit");
          expect(await tentativa).toEqual({ ok: false, code: "40001" });
          await verificacao.query("rollback");
        } finally {
          await mudanca.query("rollback").catch(() => {});
          await mudanca.end().catch(() => {});
          await verificacao.end().catch(() => {});
        }
        // A evidência que nasceria amarrada ao conteúdo velho NÃO existe, e o hash mudou de fato.
        expect(await verificacoesDe(f.fichaId)).toBe(0);
        expect(await hashDaFichaNoBanco(f.fichaId)).not.toBe(hashVelho);
        expect(await leituraDoEstudante(f.slug)).toEqual({ fonte: 0, item: 0 });
      },
    );

    it("verificação em curso (sem commit): a mudança de conteúdo espera; a evidência grava o hash do conteúdo que foi verificado, e a ficha volta a rascunho", async () => {
      const { f, sessao, hashVelho } = await fichaProntaParaVerificar();
      const mudanca = await cliente("carga");
      const verificacao = await cliente("app");
      try {
        await verificacao.query("begin");
        await verificacao.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessao,
          f.fichaId,
          hashVelho,
        ]);
        const pid = await pidDe(mudanca);
        const edicao = mudanca
          .query("update acervo.ficha set tese_pt = 'Tese mudada depois.' where fonte_id = $1", [
            f.fichaId,
          ])
          .then(() => "feita");
        await esperarBloqueio(pid);
        await verificacao.query("commit");
        expect(await edicao).toBe("feita");
      } finally {
        await verificacao.end().catch(() => {});
        await mudanca.end().catch(() => {});
      }
      const evidencia = (
        await migra.query("select ficha_hash from acervo.verificacao_ficha where ficha_id = $1", [
          f.fichaId,
        ])
      ).rows[0];
      expect(evidencia.ficha_hash).toBe(hashVelho);
      expect(await hashDaFichaNoBanco(f.fichaId)).not.toBe(hashVelho);
      // A verificação foi do conteúdo velho: o conteúdo novo é rascunho para o Estudante.
      expect(await leituraDoEstudante(f.slug)).toEqual({ fonte: 0, item: 0 });
    });

    it("conferência de item em corrida com mudança do item: espera, relê e recusa com 40001; nenhuma conferência fica", async () => {
      const f = await carregarFicha();
      const item = f.itens[0] as string;
      const hashVelho = await hashDoItemNoBanco(item);
      const mudanca = await cliente("carga");
      const conferencia = await cliente("app");
      try {
        await mudanca.query("begin");
        await mudanca.query(
          "update acervo.ficha_item set texto_pt = 'Item mudado na corrida.' where id = $1",
          [item],
        );
        await conferencia.query("begin");
        const pid = await pidDe(conferencia);
        const tentativa = conferencia
          .query("select acervo.conferir_item($1::uuid, $2, $3)", [
            sessoes["admin-com-segundo-fator"],
            item,
            hashVelho,
          ])
          .then(
            () => ({ ok: true as const }),
            (erro: { code?: string }) => ({ ok: false as const, code: erro.code }),
          );
        await esperarBloqueio(pid);
        await mudanca.query("commit");
        expect(await tentativa).toEqual({ ok: false, code: "40001" });
        await conferencia.query("rollback");
      } finally {
        await mudanca.query("rollback").catch(() => {});
        await mudanca.end().catch(() => {});
        await conferencia.end().catch(() => {});
      }
      expect(await conferenciasDe(f.fichaId)).toBe(0);
      expect(await hashDoItemNoBanco(item)).not.toBe(hashVelho);
    });

    it("controle sem corrida: sem mudança concorrente, a mesma sequência verifica", async () => {
      const { f, sessao, hashVelho } = await fichaProntaParaVerificar();
      const app = await cliente("app");
      try {
        await app.query("select acervo.verificar_ficha($1::uuid, $2::uuid, $3)", [
          sessao,
          f.fichaId,
          hashVelho,
        ]);
      } finally {
        await app.end().catch(() => {});
      }
      expect(await verificacoesDe(f.fichaId)).toBe(1);
      expect(await leituraDoEstudante(f.slug)).toEqual({ fonte: 1, item: 3 });
    });

    it("o hash gravado vem da linha travada do banco, nunca do parâmetro (inspeção da função)", async () => {
      const def = await superusuario.query<{ fonte: string }>(
        "select pg_get_functiondef('acervo.verificar_ficha(uuid, uuid, text)'::regprocedure) as fonte",
      );
      const fonte = String(def.rows[0]?.fonte);
      expect(fonte).toMatch(/for update of f/i);
      const insercoes = fonte.match(/insert into[\s\S]*?;/gi) ?? [];
      expect(insercoes).toHaveLength(2);
      for (const insercao of insercoes) expect(insercao).not.toMatch(/p_hash/);
      // Controle: o detector acusa o que procura.
      expect("insert into x values (p_hash);").toMatch(/p_hash/);
    });
  },
);

describe.skipIf(emNeon())("módulo verificacao.ts (porta comAdmin, erros tipados)", () => {
  it("não tem diretiva de Server Action (nada daqui é chamável pelo navegador)", () => {
    for (const arquivo of ["verificacao.ts", "erros.ts"]) {
      const fonte = readFileSync(path.join(RAIZ, "src", "modules", "acervo", arquivo), "utf8");
      expect(fonte, arquivo).not.toMatch(/["']use server["']/);
    }
    // Controle: o detector acusa a diretiva quando ela existe.
    expect('"use server";\nexport {}').toMatch(/["']use server["']/);
  });

  it("Admin com segundo fator: conferirItem e verificarFicha gravam, e o módulo não devolve texto do banco", async () => {
    const f = await carregarFicha();
    const sessao = sessoes["admin-com-segundo-fator"];
    for (const item of f.itens) await conferirItem(sessao, item, await hashDoItemNoBanco(item));
    expect(await conferenciasDe(f.fichaId)).toBe(3);
    await verificarFicha(sessao, f.fichaId, await hashDaFichaNoBanco(f.fichaId));
    expect(await verificacoesDe(f.fichaId)).toBe(1);
  });

  it.each(["estudante", "admin-sem-segundo-fator", "geracao-antiga", "sessao-vencida"] as const)(
    "sessão %s: SegundoFatorVencido, nada gravado",
    async (caso) => {
      const f = await carregarFicha();
      await expect(
        conferirItem(
          sessoes[caso],
          f.itens[0] as string,
          await hashDoItemNoBanco(f.itens[0] as string),
        ),
      ).rejects.toBeInstanceOf(SegundoFatorVencido);
      await expect(
        verificarFicha(sessoes[caso], f.fichaId, await hashDaFichaNoBanco(f.fichaId)),
      ).rejects.toBeInstanceOf(SegundoFatorVencido);
      expect(await conferenciasDe(f.fichaId)).toBe(0);
    },
  );

  it("ConteudoMudou, FaltamPaginas (com a contagem) e EdicaoNaoConfirmada", async () => {
    const sessao = sessoes["admin-com-segundo-fator"];
    const f = await carregarFicha();
    await expect(conferirItem(sessao, f.itens[0] as string, HASH_FALSO)).rejects.toBeInstanceOf(
      ConteudoMudou,
    );
    await expect(verificarFicha(sessao, f.fichaId, HASH_FALSO)).rejects.toBeInstanceOf(
      ConteudoMudou,
    );
    const hash = await hashDaFichaNoBanco(f.fichaId);
    const faltam = await verificarFicha(sessao, f.fichaId, hash).catch((e: unknown) => e);
    expect(faltam).toBeInstanceOf(FaltamPaginas);
    expect((faltam as FaltamPaginas).faltam).toBe(3);

    const pendente = await carregarFicha({ edicaoPendente: true });
    for (const item of pendente.itens)
      await conferirItem(sessao, item, await hashDoItemNoBanco(item));
    await expect(
      verificarFicha(sessao, pendente.fichaId, await hashDaFichaNoBanco(pendente.fichaId)),
    ).rejects.toBeInstanceOf(EdicaoNaoConfirmada);
  });

  it("outro erro do banco sobe sem texto do banco (só SQLSTATE)", async () => {
    // Transação fora de READ COMMITTED não é um caso do módulo (comAdmin abre a padrão): força um erro qualquer com uuid
    // de sessão malformado, que a porta recusa antes do banco, e um id de ficha malformado, que o banco recusa.
    const sessao = sessoes["admin-com-segundo-fator"];
    const erro = await verificarFicha(sessao, "não-é-uuid", HASH_FALSO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroDeBanco);
    expect((erro as Error).message).toBe("falha na camada de banco");
    expect(String((erro as { code?: string }).code)).toMatch(/^22/);
  });
});
