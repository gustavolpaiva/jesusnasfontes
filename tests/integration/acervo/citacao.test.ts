import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { interpretarFichaYaml } from "@/modules/acervo/schemas";
import { lerEstudoPorSlug } from "@/modules/conteudo/estudo";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";
import { verificarFichaParaTeste } from "../../support/verificar-ficha-teste";

// A Citação com três alvos e a aprovação do Grau amarrada a hash (ACER-06, ACER-10, D-04, D-12, D-16; migração 0028).
// Cada papel usa a PRÓPRIA conexão; todo negativo de papel tem o positivo (Admin com segundo fator) neste arquivo.
// Cria dado de teste: banco descartável SÓ deste arquivo, fora do Neon. Obra, Fonte e Citações são fictícias.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FICHAS = path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas");
const emNeon = () => inject("alvoBanco") === "neon";
const SEM_SESSAO = "00000000-0000-4000-8000-0000000000aa";

let banco: BancoDeExecucao | undefined;
let superusuario: pg.Client;
let carga: pg.Client;
let assistente: pg.Client;
let app: pg.Client;
let appA: pg.Client;
let appB: pg.Client;
let cargaB: pg.Client;
let ambiente: Record<string, string>;
const sessoes = {} as Record<CasoDeSessao, string>;
const admin = () => sessoes["admin-com-segundo-fator"];

async function conectar(papel: "carga" | "assistente" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
let n = 0;
const proximo = () => ++n;

type Cenario = {
  afirmacao: string;
  paragrafo: string;
  fonteSlug: string;
};

/** Uma Fonte integral publicada com um parágrafo, e uma Afirmação sem Citação. */
async function cenario(opcoes: { publicada?: boolean } = {}): Promise<Cenario> {
  const k = proximo();
  const fonteSlug = `fonte-citada-${k}`;
  const f = await superusuario.query<{ id: string }>(
    `insert into acervo.fonte (nivel, titulo, slug, tipo_texto, idioma, licenca, origem_url, publicada)
     values ('primaria', $1, $2, 'integral', 'en', 'dominio-publico', 'https://exemplo.invalid/o', $3) returning id`,
    [`Obra Fictícia ${k}`, fonteSlug, opcoes.publicada ?? true],
  );
  const fonteId = (f.rows[0] as { id: string }).id;
  await superusuario.query(
    "insert into acervo.fonte_secao (id, fonte_id, ordem, titulo, slug) values ($1, $2, 1, 'Seção', 'secao')",
    [`${fonteSlug}/secao`, fonteId],
  );
  const paragrafo = `${fonteSlug}/1.1`;
  await superusuario.query(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
     values ($1, $2, 1, 'An invented sentence for a made-up source.', '1.1', 'en')`,
    [paragrafo, `${fonteSlug}/secao`],
  );
  const afirmacao = `afirmacao-teste-${k}`;
  await superusuario.query(
    "insert into acervo.afirmacao (id, texto, texto_hash, ordem) values ($1, $2, $3, 1)",
    [afirmacao, `Frase de teste ${k}`, sha(`texto-${k}`)],
  );
  return { afirmacao, paragrafo, fonteSlug };
}

/** Insere uma Citação de parágrafo como `jnf_carga` (o papel que a carga usa). */
async function citarParagrafo(
  a: string,
  paragrafo: string,
  ordem = 1,
  trecho = "An invented sentence",
) {
  await carga.query(
    `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
     values ($1, $2, $3, 'en', $4)`,
    [a, paragrafo, trecho, ordem],
  );
}

const hashDoTexto = async (a: string) =>
  (
    (await superusuario.query("select texto_hash from acervo.afirmacao where id = $1", [a]))
      .rows[0] as { texto_hash: string }
  ).texto_hash;
const textoDe = async (a: string) =>
  (
    (await superusuario.query("select texto from acervo.afirmacao where id = $1", [a])).rows[0] as {
      texto: string;
    }
  ).texto;
/** Muda o TEXTO da Afirmação como a carga faz; o hash é do banco (migração 0032), nunca do chamador. */
const mudarTexto = (c: pg.Client, a: string, texto: string) =>
  c.query("update acervo.afirmacao set texto = $2 where id = $1", [a, texto]);
const hashDasCitacoes = async (a: string) =>
  (
    (await superusuario.query("select acervo.hash_citacoes($1) as h", [a])).rows[0] as {
      h: string;
    }
  ).h;
const contar = async (consulta: string, params: unknown[] = []) =>
  Number(((await superusuario.query(consulta, params)).rows[0] as { n: number }).n);
const aprovacoes = (a: string) =>
  contar("select count(*)::int as n from acervo.aprovacao_afirmacao where afirmacao_id = $1", [a]);

/** `acervo.aprovar_afirmacao` pela conexão `c`, com a sessão dada e os hashes ATUAIS, salvo o que for sobreposto. */
async function aprovar(
  c: pg.Client,
  sessao: string,
  a: string,
  grau = "consenso",
  hashes: { texto?: string; citacoes?: string } = {},
) {
  return c.query("select acervo.aprovar_afirmacao($1::uuid, $2, $3, $4, $5)", [
    sessao,
    a,
    hashes.texto ?? (await hashDoTexto(a)),
    grau,
    hashes.citacoes ?? (await hashDasCitacoes(a)),
  ]);
}

/** Quantas Citações e quantas aprovações o papel enxerga para a Afirmação (leitura de verdade, pela conexão do papel). */
async function leitura(c: pg.Client, a: string) {
  const cit = await c.query(
    "select count(*)::int as n from acervo.citacao where afirmacao_id = $1",
    [a],
  );
  const apr = await c.query("select grau from acervo.aprovacao_afirmacao where afirmacao_id = $1", [
    a,
  ]);
  return {
    citacoes: (cit.rows[0] as { n: number }).n,
    graus: apr.rows.map((l) => l.grau as string),
  };
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  ambiente = preparado.env;
  Object.assign(process.env, preparado.env);
  superusuario = new pg.Client({ connectionString: preparado.banco.url });
  await superusuario.connect();
  carga = await conectar("carga");
  cargaB = await conectar("carga");
  assistente = await conectar("assistente");
  app = await conectar("app");
  appA = await conectar("app");
  appB = await conectar("app");
  for (const caso of [
    "admin-com-segundo-fator",
    "admin-sem-segundo-fator",
    "estudante",
    "geracao-antiga",
    "sessao-vencida",
  ] as const) {
    sessoes[caso] = (await criarSessaoDeTeste(superusuario, caso)).sessaoId;
  }
  await superusuario.query(
    "insert into acervo.livro (numero, nome, abreviacao, capitulos) values (42, 'Lucas', 'Lc', 24) on conflict do nothing",
  );
  for (const v of [42002007, 42002008, 42002009]) {
    await superusuario.query(
      "insert into acervo.versiculo (id, livro, capitulo, numero) values ($1, 42, 2, $2) on conflict do nothing",
      [v, v - 42002000],
    );
  }
}, 180_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, cargaB, assistente, app, appA, appB, superusuario]) {
    await c?.end().catch(() => {});
  }
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("a Citação tem exatamente um alvo (restrição de linha)", () => {
  it("aceita parágrafo, item de ficha e Passagem; recusa zero alvo, dois alvos e Passagem invertida", async () => {
    const c = await cenario();
    // Parágrafo: aceita (controle positivo do instrumento).
    await citarParagrafo(c.afirmacao, c.paragrafo, 1);
    // Passagem: aceita (início e fim).
    await carga.query(
      `insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem)
       values ($1, 42002007, 42002007, 2)`,
      [c.afirmacao],
    );
    expect(
      await contar("select count(*)::int as n from acervo.citacao where afirmacao_id = $1", [
        c.afirmacao,
      ]),
    ).toBe(2);

    const recusas: [string, string, unknown[]][] = [
      [
        "nenhum alvo",
        "insert into acervo.citacao (afirmacao_id, ordem) values ($1, 3)",
        [c.afirmacao],
      ],
      [
        "parágrafo e Passagem",
        `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, versiculo_inicio, versiculo_fim, ordem)
         values ($1, $2, 42002007, 42002007, 3)`,
        [c.afirmacao, c.paragrafo],
      ],
      [
        "só o início da Passagem",
        "insert into acervo.citacao (afirmacao_id, versiculo_inicio, ordem) values ($1, 42002007, 3)",
        [c.afirmacao],
      ],
      [
        "Passagem com fim antes do início",
        `insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem)
         values ($1, 42002008, 42002007, 3)`,
        [c.afirmacao],
      ],
      [
        "ordem repetida",
        "insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, ordem) values ($1, $2, 1)",
        [c.afirmacao, c.paragrafo],
      ],
      [
        "versículo que não existe",
        `insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem)
         values ($1, 1001001, 1001001, 3)`,
        [c.afirmacao],
      ],
    ];
    for (const [nome, sql, params] of recusas) {
      await expect(carga.query(sql, params), nome).rejects.toMatchObject({
        code: expect.stringMatching(/^23/),
      });
    }
    expect(
      await contar("select count(*)::int as n from acervo.citacao where afirmacao_id = $1", [
        c.afirmacao,
      ]),
    ).toBe(2);
  });

  it("o trecho de ficha passa de 300 caracteres só no banco, não no parágrafo (D-19)", async () => {
    const f = await carregarFicha();
    const c = await cenario();
    const longo = "x".repeat(301);
    await expect(
      carga.query(
        "insert into acervo.citacao (afirmacao_id, ficha_item_id, trecho, idioma, ordem) values ($1, $2, $3, 'en', 1)",
        [c.afirmacao, f.item, longo],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await carga.query(
      "insert into acervo.citacao (afirmacao_id, ficha_item_id, trecho, idioma, ordem) values ($1, $2, $3, 'en', 1)",
      [c.afirmacao, f.item, "x".repeat(300)],
    );
    // Parágrafo de Fonte aceita trecho longo (o limite é da ficha).
    await carga.query(
      "insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem) values ($1, $2, $3, 'en', 2)",
      [c.afirmacao, c.paragrafo, longo],
    );
  });
});

/** Uma ficha de teste carregada como rascunho (obra inventada), com o id do primeiro item com página. */
async function carregarFicha(): Promise<{ slug: string; fonteId: string; item: string }> {
  const k = proximo();
  const slug = `ficha-citada-${k}`;
  const yaml = readFileSync(path.join(PASTA_FICHAS, "obra-de-teste.yaml"), "utf8").replace(
    /^slug: .*$/m,
    `slug: ${slug}`,
  );
  await carregarRascunhos([interpretarFichaYaml(yaml, `${slug}.yaml`)], { cliente: carga });
  const r = await superusuario.query<{ id: string; item: string }>(
    `select o.id, (select i.id from acervo.ficha_item i where i.ficha_id = o.id
                    and (i.pagina_inicio is not null or i.pagina_texto is not null) order by i.tipo, i.ordem limit 1) as item
       from acervo.fonte o where o.slug = $1`,
    [slug],
  );
  const l = r.rows[0] as { id: string; item: string };
  return { slug, fonteId: l.id, item: l.item };
}

describe.skipIf(emNeon())("aprovar_afirmacao: só a sessão de Admin com segundo fator grava", () => {
  it("controle positivo: Admin com segundo fator, hashes certos, grava a aprovação e o registro interno", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo);
    await aprovar(app, admin(), c.afirmacao, "posicao-majoritaria");
    const linha = (
      await superusuario.query(
        "select grau, texto_hash, citacoes_hash from acervo.aprovacao_afirmacao where afirmacao_id = $1",
        [c.afirmacao],
      )
    ).rows[0];
    expect(linha).toEqual({
      grau: "posicao-majoritaria",
      texto_hash: await hashDoTexto(c.afirmacao),
      citacoes_hash: await hashDasCitacoes(c.afirmacao),
    });
    const registro = await superusuario.query(
      "select acao, por from admin.registro_verificacao where alvo = $1",
      [c.afirmacao],
    );
    expect(registro.rows).toHaveLength(1);
    expect(registro.rows[0]?.acao).toBe("aprovar-afirmacao");
    // Reaprovar com outro grau troca o grau (o dono corrige) e mantém uma linha só.
    await aprovar(app, admin(), c.afirmacao, "disputada");
    expect(await aprovacoes(c.afirmacao)).toBe(1);
    expect(
      (
        await superusuario.query(
          "select grau from acervo.aprovacao_afirmacao where afirmacao_id = $1",
          [c.afirmacao],
        )
      ).rows[0]?.grau,
    ).toBe("disputada");
  });

  it("recusa Estudante, Admin sem segundo fator, geração antiga, sessão vencida e sessão inexistente (42501); nada gravado", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo);
    const casos: [string, string][] = [
      ["estudante", sessoes.estudante],
      ["admin sem segundo fator", sessoes["admin-sem-segundo-fator"]],
      ["geração antiga", sessoes["geracao-antiga"]],
      ["sessão vencida", sessoes["sessao-vencida"]],
      ["sessão inexistente", SEM_SESSAO],
    ];
    for (const [nome, sessao] of casos) {
      await expect(aprovar(app, sessao, c.afirmacao), nome).rejects.toMatchObject({
        code: "42501",
      });
    }
    expect(await aprovacoes(c.afirmacao)).toBe(0);
  });

  it("jnf_carga e jnf_assistente não executam a função (42501), mesmo com a sessão de Admin; nada gravado", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo);
    for (const [nome, papel] of [
      ["jnf_carga", carga],
      ["jnf_assistente", assistente],
    ] as const) {
      await expect(aprovar(papel, admin(), c.afirmacao), nome).rejects.toMatchObject({
        code: "42501",
      });
    }
    expect(await aprovacoes(c.afirmacao)).toBe(0);
  });

  it("nenhum papel da aplicação escreve a aprovação direto: insert, update e delete recusados para carga, app e assistente", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo);
    await aprovar(app, admin(), c.afirmacao);
    for (const [nome, papel] of [
      ["jnf_carga", carga],
      ["jnf_app", app],
      ["jnf_assistente", assistente],
    ] as const) {
      await expect(
        papel.query(
          "insert into acervo.aprovacao_afirmacao (afirmacao_id, texto_hash, grau, citacoes_hash) values ($1, $2, 'consenso', $2)",
          [`outra-${proximo()}`, sha("x")],
        ),
        `${nome} insert`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        papel.query(
          "update acervo.aprovacao_afirmacao set grau = 'disputada' where afirmacao_id = $1",
          [c.afirmacao],
        ),
        `${nome} update`,
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        papel.query("delete from acervo.aprovacao_afirmacao where afirmacao_id = $1", [
          c.afirmacao,
        ]),
        `${nome} delete`,
      ).rejects.toMatchObject({ code: "42501" });
    }
    expect(await aprovacoes(c.afirmacao)).toBe(1);
  });

  it("hash velho do texto ou do conjunto: 40001; sem Citação: P0002; grau fora da lista: 22023; Afirmação inexistente: 40001", async () => {
    const c = await cenario();
    await expect(aprovar(app, admin(), c.afirmacao), "sem Citação").rejects.toMatchObject({
      code: "P0002",
    });
    await citarParagrafo(c.afirmacao, c.paragrafo);
    await expect(
      aprovar(app, admin(), c.afirmacao, "consenso", { texto: sha("velho") }),
      "texto velho",
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      aprovar(app, admin(), c.afirmacao, "consenso", { citacoes: sha("velho") }),
      "conjunto velho",
    ).rejects.toMatchObject({ code: "40001" });
    await expect(aprovar(app, admin(), c.afirmacao, "quase-certo"), "grau").rejects.toMatchObject({
      code: "22023",
    });
    await expect(
      app.query("select acervo.aprovar_afirmacao($1::uuid, $2, $3, 'consenso', $3)", [
        admin(),
        "nao-existe",
        sha("a"),
      ]),
      "inexistente",
    ).rejects.toMatchObject({ code: "40001" });
    expect(await aprovacoes(c.afirmacao)).toBe(0);
  });

  it("fora de READ COMMITTED a função recusa (0A000)", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo);
    const texto = await hashDoTexto(c.afirmacao);
    const conj = await hashDasCitacoes(c.afirmacao);
    await app.query("begin isolation level repeatable read");
    try {
      await expect(
        app.query("select acervo.aprovar_afirmacao($1::uuid, $2, $3, 'consenso', $4)", [
          admin(),
          c.afirmacao,
          texto,
          conj,
        ]),
      ).rejects.toMatchObject({ code: "0A000" });
    } finally {
      await app.query("rollback");
    }
    expect(await aprovacoes(c.afirmacao)).toBe(0);
  });

  it("Citação de Fonte não publicada: recusada com P0003; publicada: aprovada (controle positivo)", async () => {
    const c = await cenario({ publicada: false });
    await citarParagrafo(c.afirmacao, c.paragrafo);
    await expect(aprovar(app, admin(), c.afirmacao)).rejects.toMatchObject({ code: "P0003" });
    expect(await aprovacoes(c.afirmacao)).toBe(0);
    await superusuario.query("update acervo.fonte set publicada = true where slug = $1", [
      c.fonteSlug,
    ]);
    await aprovar(app, admin(), c.afirmacao);
    expect(await aprovacoes(c.afirmacao)).toBe(1);
  });
});

describe.skipIf(emNeon())(
  "visibilidade: o Estudante e o Assistente só leem Citação e grau com a aprovação valendo",
  () => {
    it("Citação sem aprovação nunca é lida por jnf_app nem por jnf_assistente; com aprovação, as duas conexões a leem", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      await aprovar(app, admin(), c.afirmacao, "consenso");
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["consenso"] });
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 1, graus: ["consenso"] });
    });

    it("mudar o texto da Afirmação (texto_hash) devolve zero linhas sem apagar nada; o texto de volta restaura (mesmo hash)", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await aprovar(app, admin(), c.afirmacao, "disputada");
      const original = await textoDe(c.afirmacao);
      await mudarTexto(carga, c.afirmacao, "texto novo");
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      // Nada foi apagado: a aprovação e a Citação continuam lá.
      expect(await aprovacoes(c.afirmacao)).toBe(1);
      expect(
        await contar("select count(*)::int as n from acervo.citacao where afirmacao_id = $1", [
          c.afirmacao,
        ]),
      ).toBe(1);
      await mudarTexto(carga, c.afirmacao, original);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["disputada"] });
    });

    it("o hash do texto é do banco: a carga que muda só o texto, ou muda o texto e tenta guardar o hash velho, derruba a aprovação (0032)", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await aprovar(app, admin(), c.afirmacao, "consenso");
      const velho = await hashDoTexto(c.afirmacao);
      const textoAprovado = await textoDe(c.afirmacao);
      // O hash gravado é o sha256 do texto, não o que o teste inseriu (controle: a coluna não é mais de quem escreve).
      expect(velho).toBe(sha(await textoDe(c.afirmacao)));
      // 1. Só o texto: o hash acompanha.
      await mudarTexto(carga, c.afirmacao, "Outra afirmação que ninguém aprovou");
      expect(await hashDoTexto(c.afirmacao)).toBe(sha("Outra afirmação que ninguém aprovou"));
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      // 2. Texto novo E o hash velho no mesmo comando: o banco ignora o hash dado e calcula o do texto.
      await carga.query("update acervo.afirmacao set texto = $2, texto_hash = $3 where id = $1", [
        c.afirmacao,
        "Mais uma frase que ninguém aprovou",
        velho,
      ]);
      expect(await hashDoTexto(c.afirmacao)).toBe(sha("Mais uma frase que ninguém aprovou"));
      expect(await hashDoTexto(c.afirmacao)).not.toBe(velho);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      // 3. Dois passos (texto novo com hash qualquer, depois o hash velho de volta): o segundo passo também é recalculado.
      await carga.query("update acervo.afirmacao set texto_hash = $2 where id = $1", [
        c.afirmacao,
        velho,
      ]);
      expect(await hashDoTexto(c.afirmacao)).toBe(sha("Mais uma frase que ninguém aprovou"));
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      // Nada foi apagado, e o texto aprovado de volta restaura a aprovação (controle positivo).
      expect(await aprovacoes(c.afirmacao)).toBe(1);
      await mudarTexto(carga, c.afirmacao, textoAprovado);
      expect(await hashDoTexto(c.afirmacao)).toBe(velho);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["consenso"] });
    });

    it("o trecho guardado precisa continuar no parágrafo: se o texto do parágrafo muda, a aprovação some e uma nova é recusada (0032)", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await aprovar(app, admin(), c.afirmacao, "consenso");
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["consenso"] });
      const textoDoParagrafo = (
        await superusuario.query("select texto from acervo.fonte_paragrafo where id = $1", [
          c.paragrafo,
        ])
      ).rows[0] as { texto: string };
      // Controle positivo: só o ESPAÇO muda (quebra de linha, espaço sem quebra, espaços repetidos): o trecho segue nele.
      await superusuario.query("update acervo.fonte_paragrafo set texto = $2 where id = $1", [
        c.paragrafo,
        "An\u00a0 invented\n\n sentence for a made-up source.",
      ]);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["consenso"] });
      // O texto do parágrafo é outro: o trecho aprovado já não existe nele.
      await superusuario.query("update acervo.fonte_paragrafo set texto = $2 where id = $1", [
        c.paragrafo,
        "A different sentence, revised in a later edition.",
      ]);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      await expect(aprovar(app, admin(), c.afirmacao, "consenso")).rejects.toMatchObject({
        code: "P0003",
      });
      // Nada foi apagado: o texto de volta restaura a aprovação.
      expect(await aprovacoes(c.afirmacao)).toBe(1);
      await superusuario.query("update acervo.fonte_paragrafo set texto = $2 where id = $1", [
        c.paragrafo,
        textoDoParagrafo.texto,
      ]);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["consenso"] });
    });

    it("mudar o conjunto de Citações (acrescentar, trocar o trecho, remover) devolve zero linhas", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo, 1);
      await aprovar(app, admin(), c.afirmacao);
      expect((await leitura(app, c.afirmacao)).graus).toEqual(["consenso"]);
      // Acrescentar uma Citação (Passagem).
      await carga.query(
        `insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem) values ($1, 42002007, 42002007, 2)`,
        [c.afirmacao],
      );
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      // Remover a nova restaura o conjunto aprovado.
      await carga.query("delete from acervo.citacao where afirmacao_id = $1 and ordem = 2", [
        c.afirmacao,
      ]);
      expect((await leitura(app, c.afirmacao)).graus).toEqual(["consenso"]);
      // Trocar o trecho.
      await carga.query(
        "update acervo.citacao set trecho = 'outro trecho' where afirmacao_id = $1",
        [c.afirmacao],
      );
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
    });

    it("o Admin com segundo fator enxerga a aprovação velha e a Citação (lista do dono); sem sessão, não", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await aprovar(app, admin(), c.afirmacao);
      await mudarTexto(carga, c.afirmacao, "mudou");
      const comSessao = async (sessao: string) => {
        await appA.query("begin");
        try {
          await appA.query("select set_config('app.sessao_admin', $1, true)", [sessao]);
          return await leitura(appA, c.afirmacao);
        } finally {
          await appA.query("rollback");
        }
      };
      expect(await comSessao(admin())).toEqual({ citacoes: 1, graus: ["consenso"] });
      expect(await comSessao(sessoes.estudante)).toEqual({ citacoes: 0, graus: [] });
      expect(await comSessao(SEM_SESSAO)).toEqual({ citacoes: 0, graus: [] });
    });

    it("Fonte despublicada depois da aprovação: a Citação deixa de valer sozinha; republicada, volta", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await aprovar(app, admin(), c.afirmacao);
      await superusuario.query("update acervo.fonte set publicada = false where slug = $1", [
        c.fonteSlug,
      ]);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      await superusuario.query("update acervo.fonte set publicada = true where slug = $1", [
        c.fonteSlug,
      ]);
      expect((await leitura(app, c.afirmacao)).graus).toEqual(["consenso"]);
    });
  },
);

describe.skipIf(emNeon())(
  "Citação de ficha: só vale com a ficha verificada para o hash atual (T-02-51)",
  () => {
    it("ficha em rascunho: aprovar é recusado (P0003) e nada é lido; verificada: aprova e lê; alterada depois: some sozinha", async () => {
      const f = await carregarFicha();
      const c = await cenario();
      await carga.query(
        "insert into acervo.citacao (afirmacao_id, ficha_item_id, trecho, idioma, ordem) values ($1, $2, 'An invented line', 'en', 1)",
        [c.afirmacao, f.item],
      );
      // Rascunho: recusada pela função.
      await expect(aprovar(app, admin(), c.afirmacao)).rejects.toMatchObject({ code: "P0003" });
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });

      // Verificada pelas funções reais, com uma sessão de Admin semeada para isto.
      await verificarFichaParaTeste(ambiente, f.slug);
      await aprovar(app, admin(), c.afirmacao, "posicao-majoritaria");
      expect(await leitura(app, c.afirmacao)).toEqual({
        citacoes: 1,
        graus: ["posicao-majoritaria"],
      });
      expect(await leitura(assistente, c.afirmacao)).toEqual({
        citacoes: 1,
        graus: ["posicao-majoritaria"],
      });

      // A ficha muda DEPOIS de verificada: o banco recalcula o hash e a verificação deixa de valer; a Citação some.
      await carga.query(
        "update acervo.ficha set tese_pt = tese_pt || ' (alterada)' where fonte_id = $1",
        [f.fonteId],
      );
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      expect(await leitura(assistente, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
      // E reaprovar agora é recusado de novo.
      await expect(aprovar(app, admin(), c.afirmacao)).rejects.toMatchObject({ code: "P0003" });
    });
  },
);

describe.skipIf(emNeon())(
  "proposta de grau: só o Admin com segundo fator lê; só a carga escreve",
  () => {
    it("a carga grava a proposta; jnf_app sem sessão, jnf_assistente e Estudante não a leem; o Admin com segundo fator, sim", async () => {
      const c = await cenario();
      await carga.query(
        "insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash) values ($1, 'consenso', 'Justificativa de teste', $2)",
        [c.afirmacao, await hashDoTexto(c.afirmacao)],
      );
      const quantas = async (c2: pg.Client, sessao: string | null) => {
        await c2.query("begin");
        try {
          if (sessao !== null)
            await c2.query("select set_config('app.sessao_admin', $1, true)", [sessao]);
          return Number(
            (
              (await c2.query("select count(*)::int as n from acervo.proposta_grau")).rows[0] as {
                n: number;
              }
            ).n,
          );
        } finally {
          await c2.query("rollback");
        }
      };
      expect(await quantas(app, null)).toBe(0);
      expect(await quantas(assistente, null)).toBe(0);
      expect(await quantas(app, sessoes.estudante)).toBe(0);
      expect(await quantas(app, sessoes["admin-sem-segundo-fator"])).toBe(0);
      expect(await quantas(app, admin())).toBeGreaterThanOrEqual(1);
      // O aplicativo não escreve proposta.
      await expect(
        app.query("delete from acervo.proposta_grau where afirmacao_id = $1", [c.afirmacao]),
      ).rejects.toMatchObject({ code: "42501" });
      // Grau fora da lista é recusado pelo banco: com uma Afirmação que EXISTE e ainda não tem proposta, para que só a restrição
      // do grau possa recusar (com id inexistente a chave estrangeira recusaria do mesmo jeito, e o teste passaria sem ela).
      const semProposta = await cenario();
      await expect(
        carga.query(
          "insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash) values ($1, 'certo', 'x', $2)",
          [semProposta.afirmacao, sha("a")],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      // Controle positivo: a mesma linha com um grau da lista entra.
      await carga.query(
        "insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash) values ($1, 'consenso', 'x', $2)",
        [semProposta.afirmacao, sha("a")],
      );
    });
  },
);

describe.skipIf(emNeon())(
  "concorrência: a checagem e a escrita são do banco, sob a trava da Afirmação",
  () => {
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

    it("a Citação acrescentada ENQUANTO a aprovação lê os hashes: a aprovação espera e é recusada (40001), nada gravado", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo, 1);
      // O Admin leu o conjunto (1 Citação).
      const texto = await hashDoTexto(c.afirmacao);
      const conjuntoLido = await hashDasCitacoes(c.afirmacao);
      // A carga abre a transação e acrescenta uma Citação: segura a trava da Afirmação, ainda sem commit.
      await cargaB.query("begin");
      await cargaB.query(
        "insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem) values ($1, 42002007, 42002007, 2)",
        [c.afirmacao],
      );
      const pid = await pidDe(appA);
      const aprovacao = appA.query(
        "select acervo.aprovar_afirmacao($1::uuid, $2, $3, 'consenso', $4)",
        [admin(), c.afirmacao, texto, conjuntoLido],
      );
      // Anexa o tratamento já: a promessa pode rejeitar assim que o lock cair.
      const resultado = aprovacao.then(
        () => "gravou",
        (e: { code?: string }) => e.code ?? "erro",
      );
      await esperarBloqueio(pid);
      await cargaB.query("commit");
      expect(await resultado).toBe("40001");
      expect(await aprovacoes(c.afirmacao)).toBe(0);
    });

    it("a Citação acrescentada DEPOIS que a aprovação travou: a mudança espera, e a aprovação passa a não valer sozinha", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo, 1);
      await appA.query("begin");
      try {
        await aprovar(appA, admin(), c.afirmacao, "consenso"); // segura a trava, sem commit
        const pid = await pidDe(cargaB);
        const insercao = cargaB.query(
          "insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem) values ($1, 42002007, 42002007, 2)",
          [c.afirmacao],
        );
        await esperarBloqueio(pid);
        await appA.query("commit");
        await insercao;
      } catch (erro) {
        await appA.query("rollback").catch(() => {});
        throw erro;
      }
      // A aprovação existe, mas foi dada a um conjunto que mudou: ninguém lê.
      expect(await aprovacoes(c.afirmacao)).toBe(1);
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
    });

    // Atualizar ou apagar uma Citação NÃO passa pela chave estrangeira da Afirmação (o `insert` passa e, por acaso, já
    // serializa): só o gatilho trava a Afirmação aqui. Sem ele, estes dois testes reprovam (mutação provada).
    it.each([
      [
        "trocar o trecho",
        "update acervo.citacao set trecho = 'trecho mudado' where afirmacao_id = $1",
      ],
      ["apagar a Citação", "delete from acervo.citacao where afirmacao_id = $1 and ordem = 2"],
    ])(
      "%s ENQUANTO a aprovação lê os hashes: a aprovação espera e é recusada (40001), nada gravado",
      async (_nome, sql) => {
        const c = await cenario();
        await citarParagrafo(c.afirmacao, c.paragrafo, 1);
        await citarParagrafo(c.afirmacao, c.paragrafo, 2, "segundo trecho");
        const texto = await hashDoTexto(c.afirmacao);
        const conjuntoLido = await hashDasCitacoes(c.afirmacao);
        await cargaB.query("begin");
        await cargaB.query(sql, [c.afirmacao]);
        const pid = await pidDe(appA);
        const resultado = appA
          .query("select acervo.aprovar_afirmacao($1::uuid, $2, $3, 'consenso', $4)", [
            admin(),
            c.afirmacao,
            texto,
            conjuntoLido,
          ])
          .then(
            () => "gravou",
            (e: { code?: string }) => e.code ?? "erro",
          );
        await esperarBloqueio(pid);
        await cargaB.query("commit");
        expect(await resultado).toBe("40001");
        expect(await aprovacoes(c.afirmacao)).toBe(0);
      },
    );

    it("o texto da Afirmação mudado (a carga) ENQUANTO a aprovação trava: a carga espera e a aprovação fica obsoleta, sem ler o texto velho", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await appA.query("begin");
      try {
        await aprovar(appA, admin(), c.afirmacao, "consenso");
        const pid = await pidDe(cargaB);
        const mudanca = mudarTexto(cargaB, c.afirmacao, "novo texto");
        await esperarBloqueio(pid);
        await appA.query("commit");
        await mudanca;
      } catch (erro) {
        await appA.query("rollback").catch(() => {});
        throw erro;
      }
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 0, graus: [] });
    });

    it("duas aprovações simultâneas do mesmo conjunto: as duas passam em série e a linha é uma só", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo);
      await appA.query("begin");
      await appB.query("begin");
      try {
        await aprovar(appA, admin(), c.afirmacao, "consenso");
        const pidB = await pidDe(appB);
        const b = aprovar(appB, admin(), c.afirmacao, "disputada");
        await esperarBloqueio(pidB);
        await appA.query("commit");
        await b;
        await appB.query("commit");
      } catch (erro) {
        await appA.query("rollback").catch(() => {});
        await appB.query("rollback").catch(() => {});
        throw erro;
      }
      expect(await aprovacoes(c.afirmacao)).toBe(1);
      // A segunda (a que chegou depois) vence: o dono corrigiu o grau.
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 1, graus: ["disputada"] });
    });
  },
);

describe.skipIf(emNeon())("a Afirmação com aprovação ou proposta não some", () => {
  it("apagar a Afirmação aprovada ou com proposta é recusado pelo banco (23503)", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo);
    await aprovar(app, admin(), c.afirmacao);
    await carga.query("delete from acervo.citacao where afirmacao_id = $1", [c.afirmacao]);
    await expect(
      carga.query("delete from acervo.afirmacao where id = $1", [c.afirmacao]),
    ).rejects.toMatchObject({
      code: "23503",
    });
    const d = await cenario();
    await carga.query(
      "insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash) values ($1, 'consenso', 'j', $2)",
      [d.afirmacao, await hashDoTexto(d.afirmacao)],
    );
    await expect(
      carga.query("delete from acervo.afirmacao where id = $1", [d.afirmacao]),
    ).rejects.toMatchObject({
      code: "23503",
    });
  });

  it("hash_citacoes é do banco: estável entre chamadas, muda com ordem, alvo, trecho e idioma", async () => {
    const c = await cenario();
    await citarParagrafo(c.afirmacao, c.paragrafo, 1, "um");
    const h1 = await hashDasCitacoes(c.afirmacao);
    expect(await hashDasCitacoes(c.afirmacao)).toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    await carga.query("update acervo.citacao set idioma = 'pt' where afirmacao_id = $1", [
      c.afirmacao,
    ]);
    const h2 = await hashDasCitacoes(c.afirmacao);
    expect(h2).not.toBe(h1);
    await carga.query("update acervo.citacao set ordem = 2 where afirmacao_id = $1", [c.afirmacao]);
    expect(await hashDasCitacoes(c.afirmacao)).not.toBe(h2);
    // Conjunto vazio: hash fixo, nunca nulo.
    expect(await hashDasCitacoes(`nenhuma-${randomUUID()}`)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(emNeon())(
  "corrida: aprovação nova confirmada no meio da leitura do Estudo (revisão cruzada do 02-19)",
  () => {
    // O Estudo lê o Grau e as Citações em consultas separadas, e a política de linha valida cada uma por si. Sem o
    // instantâneo, uma aprovação confirmada entre as duas juntava o Grau antigo às Citações novas: um par que o Admin
    // nunca aprovou. Mutação provada: tirar `{ instantaneo: true }` de `lerEstudoSemPassagens` faz este teste reprovar.
    async function estudoComAfirmacao(afirmacao: string) {
      const k = proximo();
      const trilha = `trilha-corrida-${k}`;
      const slug = `estudo-corrida-${k}`;
      await superusuario.query(
        "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, 'Trilha de teste', $2, 'x')",
        [trilha, 9000 + k],
      );
      const e = await superusuario.query<{ id: string }>(
        `insert into conteudo.estudo (slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, 1, 'Estudo da corrida', 'historico', 'Corpo.', $3) returning id`,
        [slug, trilha, sha(`estudo-${k}`)],
      );
      await superusuario.query("update acervo.afirmacao set estudo_id = $2 where id = $1", [
        afirmacao,
        (e.rows[0] as { id: string }).id,
      ]);
      return slug;
    }

    const par = async (slug: string, entreLeituras?: () => Promise<void>) => {
      const estudo = await lerEstudoPorSlug(slug, { entreLeituras });
      const citacao = estudo?.afirmacoes[0]?.citacao ?? null;
      return citacao ? { grau: citacao.grau, itens: citacao.itens.length } : null;
    };

    it("o Grau e as Citações lidos juntos são sempre um par aprovado: o antigo inteiro ou o novo inteiro, nunca a mistura", async () => {
      const c = await cenario();
      await citarParagrafo(c.afirmacao, c.paragrafo, 1);
      await aprovar(app, admin(), c.afirmacao, "consenso");
      const slug = await estudoComAfirmacao(c.afirmacao);
      // Controle positivo: sem corrida, a leitura traz o par aprovado (consenso, 1 Citação).
      expect(await par(slug)).toEqual({ grau: "consenso", itens: 1 });

      let rodou = false;
      const lido = await par(slug, async () => {
        rodou = true;
        // Outra conexão confirma, entre a leitura do Grau e a das Citações: uma 2ª Citação e a aprovação nova.
        await citarParagrafo(c.afirmacao, c.paragrafo, 2, "a made-up source");
        await aprovar(app, admin(), c.afirmacao, "disputada");
      });
      expect(rodou, "o gancho da corrida rodou").toBe(true);
      // Controle de que a mudança foi confirmada: o banco já tem o par novo e o leitor sem corrida o devolve.
      expect(await leitura(app, c.afirmacao)).toEqual({ citacoes: 2, graus: ["disputada"] });
      expect(await par(slug)).toEqual({ grau: "disputada", itens: 2 });

      const antigo = { grau: "consenso", itens: 1 };
      const novo = { grau: "disputada", itens: 2 };
      expect([antigo, novo]).toContainEqual(lido);
      // No instantâneo, a leitura que começou antes da mudança vê o par antigo inteiro.
      expect(lido).toEqual(antigo);
    });
  },
);
