import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import {
  type FichaYaml,
  interpretarFichaYaml,
  interpretarFonteYaml,
} from "@/modules/acervo/schemas";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";

// As funções de escrita do painel de Fontes (ACER-08, ACER-09, D-03; migração 0022): cada papel usa a PRÓPRIA conexão
// e cada caso negativo tem o positivo (Admin com segundo fator) no mesmo arquivo. Cria dado de teste: banco descartável
// SÓ deste arquivo, fora do Neon.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo");
const emNeon = () => inject("alvoBanco") === "neon";
const SEM_SESSAO = "00000000-0000-4000-8000-0000000000aa";

const ASSINATURAS = [
  "acervo.salvar_fonte(uuid, jsonb)",
  "acervo.salvar_secao_painel(uuid, text, jsonb)",
  "acervo.salvar_resumo_secao(uuid, text, text, text[])",
  "acervo.reverter_fonte(uuid, text, text[])",
] as const;

let banco: BancoDeExecucao | undefined;
let superusuario: pg.Client;
let carga: pg.Client;
let assistente: pg.Client;
let app: pg.Client;
const sessoes = {} as Record<CasoDeSessao, string>;
const admin = () => sessoes["admin-com-segundo-fator"];

async function cliente(papel: "carga" | "assistente" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

let n = 0;
const slugNovo = () => `fonte-painel-${++n}`;

const ACADEMICA_BASE = { nivel: "academica", tipo_texto: "ficha", idioma: "pt" } as const;
const INTEGRAL_VALIDA = {
  nivel: "primaria",
  tipo_texto: "integral",
  idioma: "pt",
  licenca: "dp-declarado-pela-origem",
  origem_url: "https://exemplo.invalid/obra",
  origem_nome: "Origem de teste",
} as const;

/** `acervo.salvar_fonte` pela conexão de `c`, com a sessão dada. */
const salvar = (
  c: pg.Client,
  sessao: string,
  dados: Record<string, unknown>,
): Promise<pg.QueryResult> =>
  c.query("select acervo.salvar_fonte($1::uuid, $2::jsonb) as slug", [
    sessao,
    JSON.stringify(dados),
  ]);

const criar = (slug: string, extra: Record<string, unknown>, sessao = admin()) =>
  salvar(app, sessao, { modo: "criar", slug, titulo: `Obra ${slug}`, ...extra });

const fonteDe = async (slug: string) =>
  (await superusuario.query("select * from acervo.fonte where slug = $1", [slug])).rows[0];
const contar = async (sql: string, params: unknown[] = []): Promise<number> =>
  Number(((await superusuario.query(sql, params)).rows[0] as { n: number }).n);

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  superusuario = new pg.Client({ connectionString: preparado.banco.url });
  await superusuario.connect();
  carga = await cliente("carga");
  assistente = await cliente("assistente");
  app = await cliente("app");
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
  for (const c of [carga, assistente, app, superusuario]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("privilégio de execução das funções do painel", () => {
  it("execute só para jnf_app: nunca carga, assistente nem o público; security definer de jnf_migra", async () => {
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
      const definidora = await superusuario.query(
        "select prosecdef as definer, pg_get_userbyid(proowner) as dono from pg_proc where oid = $1::regprocedure",
        [assinatura],
      );
      expect(definidora.rows[0], assinatura).toEqual({ definer: true, dono: "jnf_migra" });
    }
  });

  it("jnf_carga e jnf_assistente chamando as quatro funções: recusado por falta de privilégio (42501)", async () => {
    const slug = slugNovo();
    for (const [papel, c] of [
      ["jnf_carga", carga],
      ["jnf_assistente", assistente],
    ] as const) {
      await expect(
        salvar(c, admin(), { modo: "criar", slug, titulo: "x", ...ACADEMICA_BASE }),
        `${papel} salvar_fonte`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        c.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
          admin(),
          slug,
          JSON.stringify({ slug: "s1", titulo: "t", texto: "a" }),
        ]),
        `${papel} salvar_secao_painel`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        c.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
          admin(),
          `${slug}/s1`,
          "r",
          ["p"],
        ]),
        `${papel} salvar_resumo_secao`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        c.query("select acervo.reverter_fonte($1::uuid, $2, null)", [admin(), slug]),
        `${papel} reverter_fonte`,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(
      await contar("select count(*)::int as n from acervo.fonte where slug = $1", [slug]),
    ).toBe(0);
  });

  it("jnf_app não escreve na Fonte por SQL direto (só pelas funções)", async () => {
    for (const comando of [
      "insert into acervo.fonte (slug, titulo, nivel) values ('direto', 'x', 'primaria')",
      "update acervo.fonte set limites_pt = 'x'",
      "delete from acervo.fonte",
    ]) {
      await expect(app.query(comando), comando).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe.skipIf(emNeon())("a sessão de Admin com segundo fator é provada DENTRO da função", () => {
  it("Estudante, Admin sem segundo fator, geração antiga, sessão vencida e sessão inexistente: 42501 e nada gravado", async () => {
    for (const caso of [
      "estudante",
      "admin-sem-segundo-fator",
      "geracao-antiga",
      "sessao-vencida",
    ] as const) {
      const slug = slugNovo();
      await expect(criar(slug, { ...INTEGRAL_VALIDA }, sessoes[caso]), caso).rejects.toMatchObject({
        code: "42501",
      });
      expect(await fonteDe(slug), caso).toBeUndefined();
    }
    const slug = slugNovo();
    await expect(criar(slug, { ...INTEGRAL_VALIDA }, SEM_SESSAO)).rejects.toMatchObject({
      code: "42501",
    });
    expect(await fonteDe(slug)).toBeUndefined();
  });

  it("controle positivo: o Admin com segundo fator cria uma Fonte com origem 'painel' e deixa registro sem texto da Fonte", async () => {
    const slug = slugNovo();
    const r = await criar(slug, { ...INTEGRAL_VALIDA, titulo: "Obra de teste", autor: "Autor" });
    expect(r.rows[0]).toEqual({ slug });
    const f = await fonteDe(slug);
    expect(f).toMatchObject({
      slug,
      titulo: "Obra de teste",
      origem_registro: "painel",
      publicada: false,
      obra_protegida: false,
      hash_ultima_carga: null,
      conflito_carga: [],
    });
    const registro = await superusuario.query(
      "select acao, hash, por from admin.registro_verificacao where alvo = $1",
      [slug],
    );
    expect(registro.rows).toHaveLength(1);
    expect(registro.rows[0]?.acao).toBe("salvar-fonte");
    expect(registro.rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(registro.rows[0]?.por).toBeTruthy();
  });

  it("a identidade vem da sessão: o registro leva o Admin da sessão, nunca um valor enviado no JSON", async () => {
    const slug = slugNovo();
    await criar(slug, {
      ...INTEGRAL_VALIDA,
      por: "00000000-0000-4000-8000-000000000001",
      admin: "outro",
    });
    const dono = await superusuario.query<{ por: string }>(
      "select por from admin.registro_verificacao where alvo = $1",
      [slug],
    );
    const esperado = await superusuario.query<{ user_id: string }>(
      "select user_id from auth.session where id = $1",
      [admin()],
    );
    expect(dono.rows[0]?.por).toBe(esperado.rows[0]?.user_id);
  });

  it("fora de READ COMMITTED a escrita é recusada (0A000); no nível padrão passa", async () => {
    const slug = slugNovo();
    await app.query("begin isolation level repeatable read");
    try {
      await expect(criar(slug, { ...INTEGRAL_VALIDA })).rejects.toMatchObject({ code: "0A000" });
    } finally {
      await app.query("rollback");
    }
    expect(await fonteDe(slug)).toBeUndefined();
    await criar(slug, { ...INTEGRAL_VALIDA });
    expect(await fonteDe(slug)).toBeDefined();
  });
});

describe.skipIf(emNeon())("ACER-09 e licença: o banco recusa, a função só deixa disparar", () => {
  it("obra protegida com texto integral não salva (23514, restrição de ACER-09) e nada fica", async () => {
    const slug = slugNovo();
    await expect(criar(slug, { ...INTEGRAL_VALIDA, obra_protegida: true })).rejects.toMatchObject({
      code: "23514",
      constraint: "fonte_obra_protegida_sem_texto_integral",
    });
    expect(await fonteDe(slug)).toBeUndefined();
    // Controle positivo: obra protegida só como ficha.
    await criar(slug, { ...ACADEMICA_BASE, obra_protegida: true });
    expect(await fonteDe(slug)).toMatchObject({ obra_protegida: true, tipo_texto: "ficha" });
  });

  it("marcar 'protegida' numa Fonte integral que já existe também é recusado, sem mudar a linha", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    await expect(
      salvar(app, admin(), {
        modo: "editar",
        slug,
        titulo: "Obra",
        ...INTEGRAL_VALIDA,
        obra_protegida: true,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect((await fonteDe(slug)).obra_protegida).toBe(false);
  });

  it("texto integral sem licença, ou com origem sem https, não salva (23514, restrição de licença)", async () => {
    for (const parte of [
      { licenca: null },
      { origem_url: null },
      { origem_url: "http://exemplo.invalid/obra" },
      { licenca: "   " },
    ]) {
      const slug = slugNovo();
      await expect(
        criar(slug, { ...INTEGRAL_VALIDA, ...parte }),
        JSON.stringify(parte),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "fonte_texto_integral_exige_licenca_e_origem",
      });
      expect(await fonteDe(slug)).toBeUndefined();
    }
    // Controle positivo: licença e origem https passam.
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    expect(await fonteDe(slug)).toMatchObject({ licenca: "dp-declarado-pela-origem" });
  });

  it("Fonte que já tem parágrafo não vira protegida nem ficha pelo painel (gatilho, 23514)", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    await app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
      admin(),
      slug,
      JSON.stringify({ slug: "s1", titulo: "Seção", texto: "Primeiro.\n\nSegundo." }),
    ]);
    await expect(
      salvar(app, admin(), {
        modo: "editar",
        slug,
        titulo: "Obra",
        ...ACADEMICA_BASE,
        obra_protegida: true,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await fonteDe(slug)).toMatchObject({ tipo_texto: "integral", obra_protegida: false });
  });

  it("leitura confessional exige a tradição (P0006); com tradição passa; outro Nível a descarta", async () => {
    const slug = slugNovo();
    await expect(criar(slug, { ...INTEGRAL_VALIDA, nivel: "confessional" })).rejects.toMatchObject({
      code: "P0006",
    });
    await criar(slug, { ...INTEGRAL_VALIDA, nivel: "confessional", tradicao: "Católica" });
    expect(await fonteDe(slug)).toMatchObject({ nivel: "confessional", tradicao: "Católica" });
    const outro = slugNovo();
    await criar(outro, { ...INTEGRAL_VALIDA, tradicao: "Católica" });
    expect((await fonteDe(outro)).tradicao).toBeNull();
  });

  it("criar com slug que já existe é recusado (23505) em vez de sobrescrever; editar o que não existe é P0005", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA, titulo: "Original" });
    await expect(criar(slug, { ...INTEGRAL_VALIDA, titulo: "Outro" })).rejects.toMatchObject({
      code: "23505",
    });
    expect((await fonteDe(slug)).titulo).toBe("Original");
    await expect(
      salvar(app, admin(), {
        modo: "editar",
        slug: "nao-existe-aqui",
        titulo: "x",
        ...ACADEMICA_BASE,
      }),
    ).rejects.toMatchObject({ code: "P0005" });
  });
});

describe.skipIf(emNeon())("Fonte do arquivo: o painel só edita limites e publicação", () => {
  const yaml = () =>
    interpretarFonteYaml(
      readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
      "josefo-antiguidades.yaml",
    );
  const derivado = () =>
    JSON.parse(readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"));

  beforeAll(async () => {
    const { interpretarDerivado } = await import("@/modules/acervo/schemas");
    await carregarFontes(
      [{ fonte: { ...yaml(), publicada: false }, derivado: interpretarDerivado(derivado(), "d") }],
      { cliente: carga },
    );
  });

  it("limites e publicação mudam; os campos do arquivo recusam (P0003) e a Fonte fica como estava", async () => {
    const antes = await fonteDe("josefo-antiguidades");
    await salvar(app, admin(), {
      modo: "editar",
      slug: "josefo-antiguidades",
      limites_pt: "Limites escritos no painel.",
      publicada: true,
    });
    const depois = await fonteDe("josefo-antiguidades");
    expect(depois).toMatchObject({ limites_pt: "Limites escritos no painel.", publicada: true });
    expect(depois.titulo).toBe(antes.titulo);
    expect(depois.hash_ultima_carga).toBe(antes.hash_ultima_carga);

    for (const campo of [
      { titulo: "Outro título" },
      { autor: "Outro autor" },
      { origem_url: "https://exemplo.invalid/x" },
      { licenca: "dp-dedicado" },
      { tipo_texto: "ficha" },
      { obra_protegida: true },
    ]) {
      await expect(
        salvar(app, admin(), { modo: "editar", slug: "josefo-antiguidades", ...campo }),
        JSON.stringify(campo),
      ).rejects.toMatchObject({ code: "P0003" });
    }
    const fim = await fonteDe("josefo-antiguidades");
    expect(fim.titulo).toBe(antes.titulo);
    expect(fim.autor).toBe(antes.autor);
    expect(fim.licenca).toBe(antes.licenca);
    // O painel não toca na marca da última carga: é ela que denuncia a edição.
    expect(fim.valores_arquivo).toEqual(antes.valores_arquivo);
  });

  it("texto de seção do arquivo nunca é editável: salvar_secao_painel recusa (P0003), o parágrafo fica igual", async () => {
    const antes = await superusuario.query(
      "select id, texto from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.63'",
    );
    await expect(
      app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
        admin(),
        "josefo-antiguidades",
        JSON.stringify({ slug: "18", titulo: "Livro 18", texto: "Texto trocado." }),
      ]),
    ).rejects.toMatchObject({ code: "P0003" });
    const depois = await superusuario.query(
      "select id, texto from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.63'",
    );
    expect(depois.rows).toEqual(antes.rows);
  });

  it("resumo e palavras-chave de uma seção do arquivo: o Admin edita; os demais papéis são recusados", async () => {
    await app.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
      admin(),
      "josefo-antiguidades/18",
      "Resumo do painel.",
      ["um", "dois"],
    ]);
    expect(
      (
        await superusuario.query(
          "select resumo_pt, palavras_chave_pt from acervo.fonte_secao where id = 'josefo-antiguidades/18'",
        )
      ).rows[0],
    ).toEqual({ resumo_pt: "Resumo do painel.", palavras_chave_pt: ["um", "dois"] });
    for (const caso of ["estudante", "admin-sem-segundo-fator"] as const) {
      await expect(
        app.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
          sessoes[caso],
          "josefo-antiguidades/18",
          "Invasor",
          [],
        ]),
        caso,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(
      (
        await superusuario.query(
          "select resumo_pt from acervo.fonte_secao where id = 'josefo-antiguidades/18'",
        )
      ).rows[0]?.resumo_pt,
    ).toBe("Resumo do painel.");
    await expect(
      app.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
        admin(),
        "josefo-antiguidades/18",
        "x",
        [" "],
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("ficha do arquivo não é editável pelo painel de Fontes (P0004); a ficha do painel é só uma casca", async () => {
    const dados: FichaYaml = interpretarFichaYaml(
      readFileSync(
        path.join(FIXTURES, "rascunhos", "fichas", "obra-de-teste.yaml"),
        "utf8",
      ).replace(/^slug: .*$/m, "slug: ficha-do-arquivo"),
      "ficha-do-arquivo.yaml",
    );
    await carregarRascunhos([dados], { cliente: carga });
    await expect(
      salvar(app, admin(), { modo: "editar", slug: "ficha-do-arquivo", limites_pt: "x" }),
    ).rejects.toMatchObject({ code: "P0004" });
    // Controle positivo: a casca de ficha criada pelo painel se edita (e nunca fica "publicada").
    const slug = slugNovo();
    await criar(slug, { ...ACADEMICA_BASE, publicada: true });
    expect(await fonteDe(slug)).toMatchObject({ tipo_texto: "ficha", publicada: false });
  });
});

describe.skipIf(emNeon())("seções e parágrafos de uma Fonte do painel", () => {
  it("o texto vira parágrafos <slug>/<n> por linha em branco; reeditar reaproveita os ids; o resto é apagado", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    const id = await app.query<{ id: string }>(
      "select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb) as id",
      [
        admin(),
        slug,
        JSON.stringify({
          slug: "s1",
          titulo: "Primeira",
          texto: "Um.\r\n\r\n\r\nDois.\n  \nTrês, em\nduas linhas.",
          resumo_pt: "Resumo.",
          palavras_chave_pt: ["a", "b"],
        }),
      ],
    );
    expect(id.rows[0]?.id).toBe(`${slug}/s1`);
    const lista = async () =>
      (
        await superusuario.query(
          "select id, ordem, texto, ref, idioma from acervo.fonte_paragrafo where secao_id = $1 order by ordem",
          [`${slug}/s1`],
        )
      ).rows;
    expect(await lista()).toEqual([
      { id: `${slug}/1`, ordem: 1, texto: "Um.", ref: "1", idioma: "pt" },
      { id: `${slug}/2`, ordem: 2, texto: "Dois.", ref: "2", idioma: "pt" },
      { id: `${slug}/3`, ordem: 3, texto: "Três, em\nduas linhas.", ref: "3", idioma: "pt" },
    ]);

    // Uma segunda seção continua a numeração da Fonte.
    await app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
      admin(),
      slug,
      JSON.stringify({ slug: "s2", titulo: "Segunda", texto: "Quatro." }),
    ]);
    expect(
      (
        await superusuario.query("select id from acervo.fonte_paragrafo where secao_id = $1", [
          `${slug}/s2`,
        ])
      ).rows,
    ).toEqual([{ id: `${slug}/4` }]);

    // Reeditar a primeira: ids por posição, e o excedente sai.
    await app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
      admin(),
      slug,
      JSON.stringify({ slug: "s1", titulo: "Primeira", texto: "Um corrigido.\n\nDois." }),
    ]);
    expect((await lista()).map((p) => [p.id, p.texto])).toEqual([
      [`${slug}/1`, "Um corrigido."],
      [`${slug}/2`, "Dois."],
    ]);
    expect(
      (
        await superusuario.query(
          "select count(*)::int as n from acervo.fonte_secao where fonte_id = (select id from acervo.fonte where slug = $1)",
          [slug],
        )
      ).rows[0]?.n,
    ).toBe(2);
  });

  it("parágrafo com Citação não é apagado por reedição (chave estrangeira) e a seção fica como estava", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    await app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
      admin(),
      slug,
      JSON.stringify({ slug: "s1", titulo: "S", texto: "Um.\n\nDois." }),
    ]);
    const hash = "a".repeat(64);
    await superusuario.query(
      "insert into acervo.afirmacao (id, texto, texto_hash) values ($1, 'x', $2)",
      [`af-${slug}`, hash],
    );
    await superusuario.query(
      "insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id) values ($1, $2)",
      [`af-${slug}`, `${slug}/2`],
    );
    // Reduzir a seção a um parágrafo apagaria o segundo, que tem Citação: a chave estrangeira recusa.
    await expect(
      app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
        admin(),
        slug,
        JSON.stringify({ slug: "s1", titulo: "S", texto: "Só um." }),
      ]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (
        await superusuario.query(
          "select texto from acervo.fonte_paragrafo where secao_id = $1 order by ordem",
          [`${slug}/s1`],
        )
      ).rows.map((r) => r.texto),
    ).toEqual(["Um.", "Dois."]);
    // Controle positivo: corrigir o texto sem tirar parágrafo passa e mantém o id citado.
    await app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
      admin(),
      slug,
      JSON.stringify({ slug: "s1", titulo: "S", texto: "Um.\n\nDois corrigido." }),
    ]);
    expect(
      (
        await superusuario.query("select texto from acervo.fonte_paragrafo where id = $1", [
          `${slug}/2`,
        ])
      ).rows[0]?.texto,
    ).toBe("Dois corrigido.");
  });

  it("título vazio, texto vazio e texto acima do teto são recusados (22023); slug inválido idem", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    const tenta = (secao: Record<string, unknown>) =>
      app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
        admin(),
        slug,
        JSON.stringify(secao),
      ]);
    await expect(tenta({ slug: "s1", titulo: " ", texto: "x" })).rejects.toMatchObject({
      code: "22023",
    });
    await expect(tenta({ slug: "s1", titulo: "t", texto: " \n\n " })).rejects.toMatchObject({
      code: "22023",
    });
    await expect(
      tenta({ slug: "s1", titulo: "t", texto: "a".repeat(80_001) }),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(tenta({ slug: "S 1", titulo: "t", texto: "x" })).rejects.toMatchObject({
      code: "22023",
    });
    expect(
      await contar("select count(*)::int as n from acervo.fonte_secao where id like $1", [
        `${slug}/%`,
      ]),
    ).toBe(0);
    // Controle positivo.
    await tenta({ slug: "s1", titulo: "t", texto: "x" });
    expect(
      await contar("select count(*)::int as n from acervo.fonte_secao where id like $1", [
        `${slug}/%`,
      ]),
    ).toBe(1);
  });

  it("texto em Fonte de ficha ou protegida é recusado pelo gatilho de ACER-09 e a seção não fica (23514)", async () => {
    const slug = slugNovo();
    await criar(slug, { ...ACADEMICA_BASE, obra_protegida: true });
    await expect(
      app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
        admin(),
        slug,
        JSON.stringify({ slug: "s1", titulo: "t", texto: "Texto integral de obra protegida." }),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      await contar("select count(*)::int as n from acervo.fonte_secao where id like $1", [
        `${slug}/%`,
      ]),
    ).toBe(0);
  });

  it("os demais papéis não criam seção (42501)", async () => {
    const slug = slugNovo();
    await criar(slug, { ...INTEGRAL_VALIDA });
    for (const caso of ["estudante", "admin-sem-segundo-fator", "sessao-vencida"] as const) {
      await expect(
        app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb)", [
          sessoes[caso],
          slug,
          JSON.stringify({ slug: "s1", titulo: "t", texto: "x" }),
        ]),
        caso,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(
      await contar("select count(*)::int as n from acervo.fonte_secao where id like $1", [
        `${slug}/%`,
      ]),
    ).toBe(0);
  });
});
