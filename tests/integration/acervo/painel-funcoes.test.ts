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
  "acervo.salvar_resumo_secao(uuid, text, text, text[], integer)",
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

/** A revisão atual da Fonte, como o formulário a leu ao abrir. */
const revisaoDe = async (slug: string): Promise<number> =>
  (
    (await superusuario.query("select revisao from acervo.fonte where slug = $1", [slug]))
      .rows[0] as { revisao: number }
  ).revisao;

/**
 * `acervo.salvar_fonte` pela conexão de `c`, com a sessão dada. Na edição, sem `revisao` explícita, manda a atual (o
 * formulário que acabou de ler a Fonte); os testes da corrida mandam a revisão velha de propósito.
 */
const salvar = async (
  c: pg.Client,
  sessao: string,
  dados: Record<string, unknown>,
): Promise<pg.QueryResult> => {
  const completos =
    dados.modo === "editar" && dados.revisao === undefined && typeof dados.slug === "string"
      ? { ...dados, revisao: await revisaoDe(dados.slug).catch(() => 0) }
      : dados;
  return c.query("select acervo.salvar_fonte($1::uuid, $2::jsonb) as slug", [
    sessao,
    JSON.stringify(completos),
  ]);
};

/** `acervo.salvar_secao_painel`: cria se a seção não existe, edita se existe (o formulário sabe qual dos dois é). */
const salvarSecao = async (
  c: pg.Client,
  sessao: string,
  slug: string,
  secao: Record<string, unknown>,
): Promise<pg.QueryResult> => {
  const existe =
    typeof secao.slug === "string" &&
    Number(
      (
        await superusuario.query(
          "select count(*)::int as n from acervo.fonte_secao where id = $1",
          [`${slug}/${secao.slug}`],
        )
      ).rows[0].n,
    ) > 0;
  const lida = existe
    ? (
        await superusuario.query("select id, versao from acervo.fonte_secao where id = $1", [
          `${slug}/${secao.slug}`,
        ])
      ).rows[0]
    : undefined;
  const { slug: _endereco, ...resto } = secao;
  return c.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb) as id", [
    sessao,
    slug,
    JSON.stringify({
      modo: existe ? "editar" : "criar",
      ...(lida ? { id: lida.id, versao: lida.versao } : { slug: secao.slug }),
      ...resto,
    }),
  ]);
};

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
    await salvarSecao(app, admin(), slug, {
      slug: "s1",
      titulo: "Seção",
      texto: "Primeiro.\n\nSegundo.",
    });
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
    const id = await salvarSecao(app, admin(), slug, {
      slug: "s1",
      titulo: "Primeira",
      texto: "Um.\r\n\r\n\r\nDois.\n  \nTrês, em\nduas linhas.",
      resumo_pt: "Resumo.",
      palavras_chave_pt: ["a", "b"],
    });
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
    await salvarSecao(app, admin(), slug, { slug: "s2", titulo: "Segunda", texto: "Quatro." });
    expect(
      (
        await superusuario.query("select id from acervo.fonte_paragrafo where secao_id = $1", [
          `${slug}/s2`,
        ])
      ).rows,
    ).toEqual([{ id: `${slug}/4` }]);

    // Reeditar a primeira: ids por posição, e o excedente sai.
    await salvarSecao(app, admin(), slug, {
      slug: "s1",
      titulo: "Primeira",
      texto: "Um corrigido.\n\nDois.",
    });
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
    await salvarSecao(app, admin(), slug, { slug: "s1", titulo: "S", texto: "Um.\n\nDois." });
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
      salvarSecao(app, admin(), slug, { slug: "s1", titulo: "S", texto: "Só um." }),
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
    await salvarSecao(app, admin(), slug, {
      slug: "s1",
      titulo: "S",
      texto: "Um.\n\nDois corrigido.",
    });
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
        JSON.stringify({ modo: "criar", ...secao }),
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
      salvarSecao(app, admin(), slug, {
        slug: "s1",
        titulo: "t",
        texto: "Texto integral de obra protegida.",
      }),
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

describe.skipIf(emNeon())(
  "seção nova nunca reaproveita endereço, e a Fonte tem revisão (revisão cruzada do plano 02-17)",
  () => {
    const secaoBruta = (slug: string, secao: Record<string, unknown>) =>
      app.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb) as id", [
        admin(),
        slug,
        JSON.stringify(secao),
      ]);

    it("criar com endereço que já existe é recusado (23505) e a seção persistida fica intacta; criar sem endereço gera o primeiro livre", async () => {
      const slug = slugNovo();
      await criar(slug, { ...INTEGRAL_VALIDA });
      // Duas seções novas SEM endereço (o formulário não sabe os que o banco gera): endereços distintos.
      const a = await secaoBruta(slug, { modo: "criar", titulo: "A", texto: "Texto de A." });
      const b = await secaoBruta(slug, { modo: "criar", titulo: "B", texto: "Texto de B." });
      expect(a.rows[0]?.id).toBe(`${slug}/secao-1`);
      expect(b.rows[0]?.id).toBe(`${slug}/secao-2`);
      // O estado velho do formulário (sem o endereço de A) tentando "criar" no endereço dela: recusado, A intacta.
      await expect(
        secaoBruta(slug, {
          modo: "criar",
          slug: "secao-1",
          titulo: "B de novo",
          texto: "Sobrescreveu.",
        }),
      ).rejects.toMatchObject({ code: "23505", constraint: "fonte_secao_pkey" });
      expect(
        (
          await superusuario.query("select titulo from acervo.fonte_secao where id = $1", [
            `${slug}/secao-1`,
          ])
        ).rows[0],
      ).toEqual({ titulo: "A" });
      expect(
        (
          await superusuario.query("select texto from acervo.fonte_paragrafo where secao_id = $1", [
            `${slug}/secao-1`,
          ])
        ).rows,
      ).toEqual([{ texto: "Texto de A." }]);
      // O endereço livre depois de remover uma seção não é reusado enquanto outra de número maior existe: o primeiro LIVRE.
      const c = await secaoBruta(slug, { modo: "criar", titulo: "C", texto: "Texto de C." });
      expect(c.rows[0]?.id).toBe(`${slug}/secao-3`);
      // Controle positivo: editar A pelo endereço dela funciona.
      const aSecao = (
        await superusuario.query("select id, versao from acervo.fonte_secao where id = $1", [
          `${slug}/secao-1`,
        ])
      ).rows[0];
      await secaoBruta(slug, {
        modo: "editar",
        id: aSecao.id,
        versao: aSecao.versao,
        titulo: "A editada",
        texto: "Texto novo de A.",
      });
      expect(
        (
          await superusuario.query("select titulo from acervo.fonte_secao where id = $1", [
            `${slug}/secao-1`,
          ])
        ).rows[0],
      ).toEqual({ titulo: "A editada" });
    });

    it("editar seção que não existe é P0005; modo ausente ou inválido é 22023; editar sem endereço é 22023", async () => {
      const slug = slugNovo();
      await criar(slug, { ...INTEGRAL_VALIDA });
      await expect(
        secaoBruta(slug, {
          modo: "editar",
          id: `${slug}/nao-existe`,
          versao: "00000000-0000-4000-8000-000000000000",
          titulo: "t",
          texto: "x",
        }),
      ).rejects.toMatchObject({ code: "P0005" });
      await expect(secaoBruta(slug, { slug: "s1", titulo: "t", texto: "x" })).rejects.toMatchObject(
        { code: "22023" },
      );
      await expect(
        secaoBruta(slug, { modo: "upsert", slug: "s1", titulo: "t", texto: "x" }),
      ).rejects.toMatchObject({ code: "22023" });
      await expect(
        secaoBruta(slug, { modo: "editar", titulo: "t", texto: "x" }),
      ).rejects.toMatchObject({ code: "22023" });
      expect(
        await contar("select count(*)::int as n from acervo.fonte_secao where id like $1", [
          `${slug}/%`,
        ]),
      ).toBe(0);
    });

    it("revisão: escrever sobre revisão velha é recusado (40001) e nada muda; a atual passa e a revisão sobe", async () => {
      const slug = slugNovo();
      await criar(slug, { ...INTEGRAL_VALIDA, titulo: "Original" });
      const lida = await revisaoDe(slug);
      await salvar(app, admin(), {
        modo: "editar",
        slug,
        titulo: "Primeira edição",
        ...INTEGRAL_VALIDA,
        revisao: lida,
      });
      expect(await revisaoDe(slug)).toBeGreaterThan(lida);
      // Outra aba ainda com a revisão `lida`: recusada.
      await expect(
        salvar(app, admin(), {
          modo: "editar",
          slug,
          titulo: "Segunda, com estado velho",
          ...INTEGRAL_VALIDA,
          revisao: lida,
        }),
      ).rejects.toMatchObject({ code: "40001" });
      expect((await fonteDe(slug)).titulo).toBe("Primeira edição");
      // Sem revisão: recusado (a função não é um upsert cego).
      await expect(
        app.query("select acervo.salvar_fonte($1::uuid, $2::jsonb)", [
          admin(),
          JSON.stringify({ modo: "editar", slug, titulo: "x", ...INTEGRAL_VALIDA }),
        ]),
      ).rejects.toMatchObject({ code: "22023" });
      // Controle positivo: com a atual passa.
      await salvar(app, admin(), { modo: "editar", slug, titulo: "Terceira", ...INTEGRAL_VALIDA });
      expect((await fonteDe(slug)).titulo).toBe("Terceira");
    });

    it("revisão também vale para o resumo da seção e sobe a cada escrita do painel", async () => {
      const slug = slugNovo();
      await criar(slug, { ...INTEGRAL_VALIDA });
      await secaoBruta(slug, { modo: "criar", titulo: "A", texto: "Texto." });
      const lida = await revisaoDe(slug);
      await app.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[], $5)", [
        admin(),
        `${slug}/secao-1`,
        "Resumo novo.",
        ["x"],
        lida,
      ]);
      expect(await revisaoDe(slug)).toBeGreaterThan(lida);
      await expect(
        app.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[], $5)", [
          admin(),
          `${slug}/secao-1`,
          "Com estado velho.",
          [],
          lida,
        ]),
      ).rejects.toMatchObject({ code: "40001" });
      expect(
        (
          await superusuario.query("select resumo_pt from acervo.fonte_secao where id = $1", [
            `${slug}/secao-1`,
          ])
        ).rows[0]?.resumo_pt,
      ).toBe("Resumo novo.");
    });

    it("mudar o idioma da Fonte muda o dos parágrafos que ela já tem (mesmo sem mudar o texto) e o índice de busca em inglês os acompanha", async () => {
      const slug = slugNovo();
      await criar(slug, { ...INTEGRAL_VALIDA, idioma: "pt" });
      await secaoBruta(slug, {
        modo: "criar",
        titulo: "A",
        texto: "The quick brown foxes jumped.\n\nSecond paragraph here.",
      });
      const estado = async () =>
        (
          await superusuario.query(
            "select idioma, tsv_en <> ''::tsvector as indexado from acervo.fonte_paragrafo where secao_id = $1 order by ordem",
            [`${slug}/secao-1`],
          )
        ).rows;
      expect(await estado()).toEqual([
        { idioma: "pt", indexado: false },
        { idioma: "pt", indexado: false },
      ]);
      await salvar(app, admin(), {
        modo: "editar",
        slug,
        titulo: "Obra",
        ...INTEGRAL_VALIDA,
        idioma: "en",
      });
      expect(await estado()).toEqual([
        { idioma: "en", indexado: true },
        { idioma: "en", indexado: true },
      ]);
      // De volta ao português: saem do índice em inglês.
      await salvar(app, admin(), {
        modo: "editar",
        slug,
        titulo: "Obra",
        ...INTEGRAL_VALIDA,
        idioma: "pt",
      });
      expect(await estado()).toEqual([
        { idioma: "pt", indexado: false },
        { idioma: "pt", indexado: false },
      ]);
    });
  },
);

describe.skipIf(emNeon())(
  "a edição de seção só escreve na seção EXATA que o cliente carregou (3ª revisão cruzada)",
  () => {
    const bruta = (slug: string, secao: Record<string, unknown>, c: pg.Client = app) =>
      c.query("select acervo.salvar_secao_painel($1::uuid, $2, $3::jsonb) as id", [
        admin(),
        slug,
        JSON.stringify(secao),
      ]);
    const paragrafosDe = async (id: string) =>
      (
        await superusuario.query(
          "select texto from acervo.fonte_paragrafo where secao_id = $1 order by ordem",
          [id],
        )
      ).rows.map((r) => r.texto);
    const identidade = async (id: string) =>
      (
        await superusuario.query(
          "select id, versao, revisao from acervo.fonte_secao where id = $1",
          [id],
        )
      ).rows[0] as { id: string; versao: string; revisao: number };
    const estadoCompleto = async (slug: string) =>
      (
        await superusuario.query(
          `select s.id, s.titulo, s.versao, (select string_agg(p.texto, '|' order by p.ordem) from acervo.fonte_paragrafo p where p.secao_id = s.id) as textos
             from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id where f.slug = $1 order by s.id`,
          [slug],
        )
      ).rows;

    /** Duas seções: A com 3 parágrafos e B com 1. `revisao` ou `versao` iguais entre elas é o ponto do ataque. */
    async function duasSecoes() {
      const slug = slugNovo();
      await criar(slug, { ...INTEGRAL_VALIDA });
      await bruta(slug, { modo: "criar", titulo: "A", texto: "A1.\n\nA2.\n\nA3." });
      await bruta(slug, { modo: "criar", titulo: "B", texto: "B1." });
      return {
        slug,
        A: await identidade(`${slug}/secao-1`),
        B: await identidade(`${slug}/secao-2`),
      };
    }

    it("A e B com revisões IDÊNTICAS (0 e 0): nenhuma combinação de identificadores trocados é aceita e os 3 parágrafos de A ficam", async () => {
      const { slug, A, B } = await duasSecoes();
      expect(A.revisao).toBe(B.revisao); // o ponto do achado: o contador não distingue as seções
      expect(A.versao).not.toBe(B.versao); // a versão distingue
      const antes = await estadoCompleto(slug);
      const conteudoDeB = { titulo: "B", texto: "B1." };
      const combinacoes: [string, Record<string, unknown>, string][] = [
        ["id de A + versão de B", { id: A.id, versao: B.versao }, "40001"],
        ["id de B + versão de A", { id: B.id, versao: A.versao }, "40001"],
        [
          "id de A + versão de A + endereço de B",
          { id: A.id, versao: A.versao, slug: "secao-2" },
          "22023",
        ],
        [
          "id de B + versão de B + endereço de A",
          { id: B.id, versao: B.versao, slug: "secao-1" },
          "22023",
        ],
        ["só o endereço de A, sem id nem versão", { slug: "secao-1" }, "22023"],
        ["id de A sem versão", { id: A.id }, "22023"],
        ["versão de A sem id", { versao: A.versao }, "22023"],
        [
          "id de A + versão inventada",
          { id: A.id, versao: "99999999-9999-4999-8999-999999999999" },
          "40001",
        ],
        ["id de A + versão que não é uuid", { id: A.id, versao: "7" }, "22023"],
        [
          "id de A + revisão numérica igual (o contador antigo)",
          { id: A.id, revisao: A.revisao },
          "22023",
        ],
      ];
      for (const [rotulo, ident, codigo] of combinacoes) {
        await expect(
          bruta(slug, { modo: "editar", ...ident, ...conteudoDeB }),
          rotulo,
        ).rejects.toMatchObject({ code: codigo });
        expect(await estadoCompleto(slug), `${rotulo}: nada mudou`).toEqual(antes);
      }
      expect(await paragrafosDe(A.id)).toEqual(["A1.", "A2.", "A3."]);
    });

    it("também com revisões 1 e 1 (as duas editadas uma vez): a versão segue distinguindo", async () => {
      const { slug } = await duasSecoes();
      await salvarSecao(app, admin(), slug, {
        slug: "secao-1",
        titulo: "A1",
        texto: "A1.\n\nA2.\n\nA3.",
      });
      await salvarSecao(app, admin(), slug, { slug: "secao-2", titulo: "B1", texto: "B1." });
      const A = await identidade(`${slug}/secao-1`);
      const B = await identidade(`${slug}/secao-2`);
      expect([A.revisao, B.revisao]).toEqual([1, 1]);
      const antes = await estadoCompleto(slug);
      await expect(
        bruta(slug, { modo: "editar", id: A.id, versao: B.versao, titulo: "B", texto: "B1." }),
      ).rejects.toMatchObject({ code: "40001" });
      await expect(
        bruta(slug, { modo: "editar", id: B.id, versao: A.versao, titulo: "A", texto: "A1." }),
      ).rejects.toMatchObject({ code: "40001" });
      expect(await estadoCompleto(slug)).toEqual(antes);
    });

    it("a edição legítima de A funciona, muda a versão, e escreve só em A (B intacta); o apagar de excedente fica dentro de A", async () => {
      const { slug, A, B } = await duasSecoes();
      const antesB = await estadoCompleto(slug).then((l) => l.find((x) => x.id === B.id));
      await bruta(slug, {
        modo: "editar",
        id: A.id,
        versao: A.versao,
        titulo: "A nova",
        texto: "Só um de A.",
      });
      const depoisA = await identidade(A.id);
      expect(depoisA.versao).not.toBe(A.versao);
      expect(await paragrafosDe(A.id)).toEqual(["Só um de A."]);
      expect(await estadoCompleto(slug).then((l) => l.find((x) => x.id === B.id))).toEqual(antesB);
      // A versão antiga de A já não vale: nem com o conteúdo certo.
      await expect(
        bruta(slug, { modo: "editar", id: A.id, versao: A.versao, titulo: "A", texto: "Velho." }),
      ).rejects.toMatchObject({ code: "40001" });
      expect(await paragrafosDe(A.id)).toEqual(["Só um de A."]);
    });

    it("seção de OUTRA Fonte: o id de outra Fonte com a versão certa dela é recusado quando o pedido é de uma Fonte que não é a dela (22023)", async () => {
      const X = await duasSecoes();
      const Y = await duasSecoes();
      const antesY = await estadoCompleto(Y.slug);
      await expect(
        bruta(X.slug, {
          modo: "editar",
          id: Y.A.id,
          versao: Y.A.versao,
          titulo: "Invasor",
          texto: "Invasor.",
        }),
      ).rejects.toMatchObject({ code: "22023" });
      expect(await estadoCompleto(Y.slug)).toEqual(antesY);
    });

    it("o resumo da seção também regera a versão: o formulário com a versão anterior é recusado e nada é apagado", async () => {
      const { slug, A } = await duasSecoes();
      await app.query("select acervo.salvar_resumo_secao($1::uuid, $2, $3, $4::text[])", [
        admin(),
        A.id,
        "Resumo.",
        ["x"],
      ]);
      expect((await identidade(A.id)).versao).not.toBe(A.versao);
      await expect(
        bruta(slug, {
          modo: "editar",
          id: A.id,
          versao: A.versao,
          titulo: "A",
          texto: "Do formulário velho.",
        }),
      ).rejects.toMatchObject({ code: "40001" });
      expect(await paragrafosDe(A.id)).toEqual(["A1.", "A2.", "A3."]);
    });

    it("edição concorrente da MESMA seção: a segunda, com a mesma versão, espera a primeira e é recusada (40001)", async () => {
      const { slug, A } = await duasSecoes();
      const outra = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: false }) });
      await outra.connect();
      try {
        await app.query("begin");
        await bruta(slug, {
          modo: "editar",
          id: A.id,
          versao: A.versao,
          titulo: "Primeira",
          texto: "Da primeira.",
        });
        const pid = (await outra.query("select pg_backend_pid() as pid")).rows[0].pid as number;
        const segunda = bruta(
          slug,
          { modo: "editar", id: A.id, versao: A.versao, titulo: "Segunda", texto: "Da segunda." },
          outra,
        );
        const resultado = segunda.then(
          () => "passou",
          (e: { code?: string }) => e.code,
        );
        let esperando = false;
        for (let i = 0; i < 100 && !esperando; i++) {
          const r = await superusuario.query(
            "select wait_event_type from pg_stat_activity where pid = $1",
            [pid],
          );
          esperando = r.rows[0]?.wait_event_type === "Lock";
          if (!esperando) await new Promise((res) => setTimeout(res, 50));
        }
        expect(esperando, "a segunda edição deve esperar o lock").toBe(true);
        await app.query("commit");
        expect(await resultado).toBe("40001");
        expect(await paragrafosDe(A.id)).toEqual(["Da primeira."]);
      } finally {
        await app.query("rollback").catch(() => {});
        await outra.end().catch(() => {});
      }
    });

    it("ATAQUE (repetição): a mesma edição legítima enviada duas vezes (duplo clique, nova tentativa de rede) só vale a primeira vez", async () => {
      const { slug, A } = await duasSecoes();
      const pedido = {
        modo: "editar",
        id: A.id,
        versao: A.versao,
        titulo: "A",
        texto: "Só um de A.\n\nDois de A.",
      };
      await bruta(slug, pedido);
      const aposPrimeira = await estadoCompleto(slug);
      await expect(bruta(slug, pedido)).rejects.toMatchObject({ code: "40001" });
      expect(await estadoCompleto(slug)).toEqual(aposPrimeira);
      // Mesmo que a segunda tentativa traga o conteúdo da primeira de volta depois de uma edição de outro lado, a versão
      // que ela viu já não é a atual: a edição que a sucedeu não é desfeita em silêncio.
      const meio = await identidade(A.id);
      await bruta(slug, {
        modo: "editar",
        id: A.id,
        versao: meio.versao,
        titulo: "A",
        texto: "Edição de outro lado.",
      });
      await expect(bruta(slug, pedido)).rejects.toMatchObject({ code: "40001" });
      expect(await paragrafosDe(A.id)).toEqual(["Edição de outro lado."]);
    });

    it("ATAQUE: id com truques de texto, endereço com id de outro prefixo e versão em maiúsculas não furam a checagem", async () => {
      const { slug, A } = await duasSecoes();
      const antes = await estadoCompleto(slug);
      const alvos: Record<string, unknown>[] = [
        { id: `${A.id} `, versao: A.versao },
        { id: A.id.toUpperCase(), versao: A.versao },
        { id: `${slug}/secao-1' or '1'='1`, versao: A.versao },
        { id: `%${slug}/secao-1`, versao: A.versao },
        { id: A.id, versao: A.versao.toUpperCase() },
        { id: A.id, versao: `${A.versao} ` },
        { id: A.id, versao: `{${A.versao}}` },
      ];
      for (const alvo of alvos) {
        await expect(
          bruta(slug, { modo: "editar", ...alvo, titulo: "X", texto: "Invasor." }),
          JSON.stringify(alvo),
        ).rejects.toMatchObject({ code: expect.stringMatching(/^(22023|P0005|40001)$/) });
      }
      expect(await estadoCompleto(slug)).toEqual(antes);
      expect(await paragrafosDe(A.id)).toEqual(["A1.", "A2.", "A3."]);
    });
  },
);
