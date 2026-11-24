// Medição SP-7 da busca do Acervo (ACER-05): tamanho de tabela e de índice, latência da busca como `jnf_app` (com a
// política de linha) e como o dono (sem ela), o plano de execução e o custo do `ts_headline` sobre uma página.
//
// Imprime SÓ números, nomes de objeto e rótulos de consulta: nenhum texto de Fonte e nenhuma credencial (o termo
// buscado é uma palavra de teste do relatório). Lê as credenciais por NOME do ambiente (`urlDoPapel`).
//
//   pnpm exec tsx scripts/acervo/medir-busca.ts --local        # banco descartável local, com o Josefo real
//   (com as variáveis do banco de desenvolvimento no ambiente) pnpm exec tsx scripts/acervo/medir-busca.ts --neon [--so-tamanho]
//
// `--local` cria o banco, carrega o derivado real do Josefo, mede o tamanho SEM as colunas de busca, aplica de novo
// a migração 0021 (idempotente) como `jnf_migra`, mede o tamanho COM elas e roda a latência. `--neon` mede o banco
// de desenvolvimento no estado em que ele está (aplique a migração entre duas rodadas para ter antes e depois).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { urlDoPapel } from "../../src/db/url";
import { registrarErro } from "../../src/lib/registro";
import { consultaDaBusca } from "../../src/modules/acervo/busca";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
type Env = Record<string, string | undefined>;

/** Palavras de frequência diferente no texto em inglês do Josefo (e uma só de palavras vazias, como controle). */
const TERMOS: { classe: string; termo: string }[] = [
  { classe: "rara", termo: "Pilate" },
  { classe: "media", termo: "Caesar" },
  { classe: "comum", termo: "Jesus" },
  { classe: "muito comum", termo: "Jews" },
  { classe: "muito comum", termo: "God" },
  { classe: "so palavra vazia", termo: "the" },
  { classe: "inexistente", termo: "zzxqwvbn" },
];
const REPETICOES = 30;

const ms = (t0: bigint): number => Number(process.hrtime.bigint() - t0) / 1e6;
const arredondar = (n: number): number => Math.round(n * 10) / 10;

function resumo(amostras: number[]): { n: number; mediana: number; p95: number; max: number } {
  const o = [...amostras].sort((a, b) => a - b);
  const em = (q: number) => o[Math.min(o.length - 1, Math.ceil(q * o.length) - 1)] ?? 0;
  return {
    n: o.length,
    mediana: arredondar(em(0.5)),
    p95: arredondar(em(0.95)),
    max: arredondar(o[o.length - 1] ?? 0),
  };
}

async function cliente(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}

/** Tamanho em bytes de tabela (com índices e TOAST) e de cada índice de busca. Só nomes de objeto e números. */
async function tamanhos(c: pg.Client): Promise<Record<string, unknown>> {
  const tabelas = await c.query<{ tabela: string; total: string; heap: string; linhas: string }>(`
    select c.relname as tabela, pg_total_relation_size(c.oid)::text as total,
           pg_table_size(c.oid)::text as heap, c.reltuples::bigint::text as linhas
      from pg_class c
     where c.relnamespace = 'acervo'::regnamespace and c.relkind = 'r'
       and c.relname in ('fonte', 'fonte_secao', 'fonte_paragrafo', 'ficha', 'ficha_item')
     order by 1`);
  const indices = await c.query<{ indice: string; bytes: string }>(`
    select ic.relname as indice, pg_relation_size(ic.oid)::text as bytes
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_am am on am.oid = ic.relam
     where ic.relnamespace = 'acervo'::regnamespace and am.amname = 'gin'
     order by 1`);
  const contagem = await c.query<{ f: string; s: string; p: string }>(
    `select (select count(*) from acervo.fonte)::text as f, (select count(*) from acervo.fonte_secao)::text as s,
            (select count(*) from acervo.fonte_paragrafo)::text as p`,
  );
  const texto = await c.query<{ bytes: string }>(
    "select coalesce(sum(octet_length(texto)), 0)::text as bytes from acervo.fonte_paragrafo",
  );
  return {
    tabelas: tabelas.rows.map((l) => ({
      tabela: l.tabela,
      total_bytes: Number(l.total),
      tabela_sem_indices_bytes: Number(l.heap),
    })),
    indices_gin: indices.rows.map((l) => ({ indice: l.indice, bytes: Number(l.bytes) })),
    linhas: {
      fontes: Number(contagem.rows[0]?.f),
      secoes: Number(contagem.rows[0]?.s),
      paragrafos: Number(contagem.rows[0]?.p),
    },
    bytes_de_texto_dos_paragrafos: Number(texto.rows[0]?.bytes),
  };
}

async function medirConsulta(
  c: pg.Client,
  texto: string,
  params: unknown[],
): Promise<ReturnType<typeof resumo>> {
  const amostras: number[] = [];
  // Uma rodada de aquecimento (cache de plano e de página) fora da amostra, como o usuário sentiria depois da 1ª.
  await c.query(texto, params);
  for (let i = 0; i < REPETICOES; i++) {
    const t0 = process.hrtime.bigint();
    await c.query(texto, params);
    amostras.push(ms(t0));
  }
  return resumo(amostras);
}

async function tempoNoServidor(c: pg.Client, texto: string, params: unknown[]): Promise<number> {
  const r = await c.query<{ "QUERY PLAN": { "Execution Time": number }[] }>(
    `explain (analyze, format json) ${texto}`,
    params,
  );
  return arredondar(r.rows[0]?.["QUERY PLAN"]?.[0]?.["Execution Time"] ?? 0);
}

/** Corpo da porta de candidatos como comando preparado (o plano do que o dono executa por dentro dela). */
async function planoDoCorpo(
  dono: pg.Client,
  termo: string,
): Promise<{ nos: string[]; execucao_ms: number }> {
  const corpo = (
    await dono.query<{ src: string }>(
      "select prosrc as src from pg_proc where oid = 'acervo.buscar_candidatos(text, text[], integer, integer)'::regprocedure",
    )
  ).rows[0]?.src;
  if (!corpo)
    throw new Error("a porta acervo.buscar_candidatos não existe: aplique a migração 0021");
  const preparado = corpo
    .replaceAll("p_termo", "$1")
    .replaceAll("p_niveis", "$2")
    .replaceAll("p_limite", "$3")
    .replaceAll("p_desloc", "$4");
  await dono.query("begin");
  try {
    await dono.query(`prepare plano_busca_sp7 (text, text[], integer, integer) as ${preparado}`);
    const plano = await dono.query<{ "QUERY PLAN": string }>(
      `explain (analyze, buffers, costs off) execute plano_busca_sp7(${dono.escapeLiteral(termo)}, null, 20, 0)`,
    );
    const linhas = plano.rows.map((l) => l["QUERY PLAN"]);
    return {
      nos: linhas
        .filter((l) => /(Index|Seq|Bitmap).*Scan/.test(l))
        .map((l) => l.replace(/\(actual.*$/, "").trim()),
      execucao_ms: Number(/Execution Time: ([\d.]+) ms/.exec(linhas.join("\n"))?.[1] ?? Number.NaN),
    };
  } finally {
    await dono.query("rollback");
    await dono.query("deallocate all");
  }
}

async function latencias(env: Env, agrupada: boolean): Promise<Record<string, unknown>> {
  const app = await cliente(urlDoPapel("app", { agrupada }, env));
  const dono = await cliente(urlDoPapel("migra", { agrupada: false }, env));
  const dialeto = new PgDialect();
  const saida: Record<string, unknown> = {};
  try {
    const porTermo: Record<string, unknown>[] = [];
    for (const { classe, termo } of TERMOS) {
      const { sql: texto, params } = dialeto.sqlToQuery(
        consultaDaBusca({ termo, niveis: null, deslocamento: 0 }),
      );
      const achados = await app.query<{ total: string }>(texto, params);
      const total = Number(achados.rows[0]?.total ?? 0);
      const comoApp = await medirConsulta(app, texto, params);
      const servidorApp = await tempoNoServidor(app, texto, params);

      // Leitura DIRETA por `jnf_app` (a política de linha tira o GIN do plano) contra a porta (usa o GIN).
      const direta =
        "select count(*)::int as n from acervo.fonte_paragrafo p where p.tsv_en @@ websearch_to_tsquery('english', $1)";
      const dir = await medirConsulta(app, direta, [termo]);
      const dirDono = await medirConsulta(dono, direta, [termo]);
      const porta = await medirConsulta(
        app,
        "select count(*)::int as n from acervo.buscar_candidatos($1, null::text[], 20, 0)",
        [termo],
      );
      porTermo.push({
        classe,
        termo,
        secoes_que_casam: total,
        busca_como_jnf_app_cliente_ms: comoApp,
        busca_como_jnf_app_servidor_ms: servidorApp,
        porta_de_candidatos_como_jnf_app_ms: porta,
        leitura_direta_como_jnf_app_com_politica_ms: dir,
        leitura_direta_como_dono_sem_politica_ms: dirDono,
      });
    }
    saida.por_termo = porTermo;

    // Plano do corpo da porta (como o dono), sem forçar nada: o que o planejador escolhe com o corpus real.
    const planos: Record<string, unknown> = {};
    for (const termo of ["Pilate", "Jews"]) planos[termo] = await planoDoCorpo(dono, termo);
    saida.plano_do_corpo_da_porta = planos;

    // ts_headline sobre os 20 melhores parágrafos de uma palavra comum: o custo do realce, isolado.
    const ids = await dono.query<{ id: string }>(
      `select id from acervo.fonte_paragrafo
        where tsv_en @@ websearch_to_tsquery('english', 'Jews')
        order by ts_rank(tsv_en, websearch_to_tsquery('english', 'Jews')) desc limit 20`,
    );
    const headline = await medirConsulta(
      dono,
      `select ts_headline('english', translate(texto, E'\\uE000\\uE001', ''), websearch_to_tsquery('english', 'Jews'),
              'StartSel=\\uE000, StopSel=\\uE001, MaxWords=35, MinWords=15, MaxFragments=1') as t
         from acervo.fonte_paragrafo where id = any($1::text[])`,
      [ids.rows.map((l) => l.id)],
    );
    saida.ts_headline_sobre_20_paragrafos_ms = { paragrafos: ids.rowCount, ...headline };
  } finally {
    await app.end().catch(() => {});
    await dono.end().catch(() => {});
  }
  return saida;
}

/** Copia o Josefo real `copias` vezes (Fontes de teste do banco descartável) para medir com o tamanho de um corpus maior. */
async function escalar(dono: pg.Client, copias: number): Promise<void> {
  await dono.query(
    `insert into acervo.fonte (slug, titulo, autor, epoca, nivel, tipo_texto, idioma, licenca, licenca_url,
                               origem_nome, origem_url, tradutor, traducao_ano, edicao, publicada)
     select o.slug || '-c' || g, o.titulo, o.autor, o.epoca, o.nivel, o.tipo_texto, o.idioma, o.licenca, o.licenca_url,
            o.origem_nome, o.origem_url, o.tradutor, o.traducao_ano, o.edicao, true
       from acervo.fonte o, generate_series(1, $1::int) g where o.slug = 'josefo-antiguidades'`,
    [copias],
  );
  await dono.query(
    `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo)
     select f.slug || '/' || s.slug, f.id, s.slug, s.ordem, s.titulo
       from acervo.fonte f
       join acervo.fonte o on o.slug = 'josefo-antiguidades'
       join acervo.fonte_secao s on s.fonte_id = o.id
      where f.slug like 'josefo-antiguidades-c%'`,
  );
  await dono.query(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, ref_inicio, ref_fim, idioma)
     select f.slug || '/' || p.ref, f.slug || '/' || s.slug, p.ordem, p.texto, p.ref, p.ref_inicio, p.ref_fim, p.idioma
       from acervo.fonte f
       join acervo.fonte o on o.slug = 'josefo-antiguidades'
       join acervo.fonte_secao s on s.fonte_id = o.id
       join acervo.fonte_paragrafo p on p.secao_id = s.id
      where f.slug like 'josefo-antiguidades-c%'`,
  );
  await dono.query("analyze");
}

async function local(copias: number): Promise<void> {
  const { criarBancoPreparado, removerBancoDeExecucao } = await import(
    "../../tests/support/banco-local"
  );
  const { semearAcervoReal } = await import("../../tests/support/preparar-banco");
  const preparado = await criarBancoPreparado();
  const env = { ...process.env, ...preparado.env } as Env;
  try {
    process.chdir(RAIZ);
    await semearAcervoReal(env);
    const dono = await cliente(urlDoPapel("migra", { agrupada: false }, env));
    try {
      // ANTES: sem as colunas de busca (o que o banco tinha antes da 0021). A função sai junto, porque lê as colunas.
      await dono.query(
        "drop function if exists acervo.buscar_candidatos(text, text[], integer, integer)",
      );
      for (const [tabela, coluna] of [
        ["fonte_secao", "tsv_pt"],
        ["fonte_paragrafo", "tsv_en"],
        ["ficha", "tsv_pt"],
        ["ficha_item", "tsv_pt"],
      ])
        await dono.query(`alter table acervo.${tabela} drop column if exists ${coluna}`);
      await dono.query(
        "vacuum full acervo.fonte_secao, acervo.fonte_paragrafo, acervo.ficha, acervo.ficha_item",
      );
      const antes = await tamanhos(dono);

      // DEPOIS: a própria migração, aplicada como o executor a aplicaria (idempotente), com o tempo que levou.
      const sql = readFileSync(
        path.join(RAIZ, "db", "migrations", "0021_acervo_busca.sql"),
        "utf8",
      );
      const t0 = process.hrtime.bigint();
      await dono.query("begin");
      await dono.query(sql);
      await dono.query("commit");
      const aplicarMs = arredondar(ms(t0));
      await dono.query("analyze");
      const depois = await tamanhos(dono);
      console.log(
        JSON.stringify({ alvo: "local", antes, depois, migracao_0021_ms: aplicarMs }, null, 1),
      );
      console.log(
        JSON.stringify(
          { alvo: "local", escala: 1, latencia: await latencias(env, false) },
          null,
          1,
        ),
      );
      if (copias > 1) {
        await escalar(dono, copias - 1);
        console.log(
          JSON.stringify(
            {
              alvo: "local",
              escala: copias,
              tamanhos: await tamanhos(dono),
              latencia: await latencias(env, false),
            },
            null,
            1,
          ),
        );
      }
    } finally {
      await dono.end().catch(() => {});
    }
  } finally {
    await removerBancoDeExecucao(preparado.banco.nome).catch(() => {});
  }
}

async function neon(soTamanho: boolean): Promise<void> {
  const dono = await cliente(urlDoPapel("migra", { agrupada: false }));
  try {
    const colunas = await dono.query<{ n: string }>(
      `select count(*)::text as n from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = 'acervo'::regnamespace and a.attname in ('tsv_pt', 'tsv_en') and not a.attisdropped`,
    );
    console.log(
      JSON.stringify(
        {
          alvo: "neon",
          colunas_de_busca_presentes: Number(colunas.rows[0]?.n),
          tamanhos: await tamanhos(dono),
        },
        null,
        1,
      ),
    );
    if (soTamanho) return;
  } finally {
    await dono.end().catch(() => {});
  }
  console.log(
    JSON.stringify({ alvo: "neon", latencia: await latencias(process.env, true) }, null, 1),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argumentos = process.argv.slice(2);
  const alvo = argumentos.includes("--local")
    ? local(Number(argumentos[argumentos.indexOf("--escala") + 1] ?? 1) || 1)
    : argumentos.includes("--neon")
      ? neon(argumentos.includes("--so-tamanho"))
      : null;
  if (!alvo) {
    console.error("Uso: medir-busca.ts --local [--escala N] | --neon [--so-tamanho]");
    process.exit(2);
  }
  alvo.then(
    () => process.exit(0),
    (erro) => {
      registrarErro("medir-busca", erro);
      if (process.env.MEDIR_DEPURAR && erro instanceof Error)
        console.error(erro.stack?.split("\n").slice(0, 6).join("\n"));
      process.exit(1);
    },
  );
}
