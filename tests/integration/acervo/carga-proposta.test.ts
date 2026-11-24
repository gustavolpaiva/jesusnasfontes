import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { interpretarDerivado, interpretarFichaYaml } from "@/modules/acervo/schemas";
import {
  carregarPropostas,
  carregarRascunhos,
  executarRascunhos,
  lerOpcoes,
  lerPropostasConferidas,
} from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";

// A carga das PROPOSTAS de Grau e de Citação (plano 02-20, D-04, D-12; T-02-55 e T-02-56). Uma proposta chega ao banco
// como Citação que ninguém vê até o dono aprovar; a carga não toca Afirmação já aprovada; é idempotente.
// Cria dado de teste: banco descartável SÓ deste arquivo, fora do Neon. Afirmações, ficha e aprovação são fictícias.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo");
const PASTA_PROPOSTAS = path.join(FIXTURES, "rascunhos", "propostas");
const PASTA_FICHAS = path.join(FIXTURES, "rascunhos", "fichas");
const emNeon = () => inject("alvoBanco") === "neon";
const SEM_SESSAO = "00000000-0000-4000-8000-0000000000aa";

const FRASES: Record<string, string> = {
  "pc91-a1": "Frase sintética um, sobre o testemunho de um historiador antigo.",
  "pc91-a2": "Frase sintética dois, apoiada numa ficha fictícia.",
  "pc91-a3": "Frase sintética três, apoiada num texto bíblico.",
  "pc91-a4": "Frase sintética quatro, sem nenhuma Fonte do Acervo.",
};
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

let banco: BancoDeExecucao | undefined;
let superusuario: pg.Client;
let carga: pg.Client;
let assistente: pg.Client;
let app: pg.Client;
const sessoes = {} as Record<CasoDeSessao, string>;
const admin = () => sessoes["admin-com-segundo-fator"];
const temporarios: string[] = [];

async function conectar(papel: "carga" | "assistente" | "app"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

const contar = async (sql: string, params: unknown[] = []) =>
  Number(((await superusuario.query(sql, params)).rows[0] as { n: number }).n);

/** Limpa o que a carga e a aprovação gravaram, para cada teste partir do mesmo estado (o semeado fica). */
async function limpar() {
  await superusuario.query("delete from acervo.aprovacao_afirmacao");
  await superusuario.query("delete from acervo.citacao");
  await superusuario.query("delete from acervo.proposta_grau");
}

/** Cópia da pasta de propostas com uma troca de texto no YAML, para os casos de mudança. */
function pastaComTroca(de: string, para: string): string {
  const pasta = mkdtempSync(path.join(tmpdir(), "jnf-propostas-"));
  temporarios.push(pasta);
  const yaml = readFileSync(path.join(PASTA_PROPOSTAS, "graus-propostos.yaml"), "utf8");
  expect(yaml).toContain(de);
  writeFileSync(path.join(pasta, "graus-propostos.yaml"), yaml.replace(de, para));
  return pasta;
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  superusuario = new pg.Client({ connectionString: preparado.banco.url });
  await superusuario.connect();
  carga = await conectar("carga");
  assistente = await conectar("assistente");
  app = await conectar("app");
  for (const caso of ["admin-com-segundo-fator", "admin-sem-segundo-fator", "estudante"] as const) {
    sessoes[caso] = (await criarSessaoDeTeste(superusuario, caso)).sessaoId;
  }

  // Bíblia mínima: Lucas 2:7 e 2:8.
  await superusuario.query(
    "insert into acervo.livro (numero, nome, abreviacao, capitulos) values (42, 'Lucas', 'Lc', 24) on conflict do nothing",
  );
  for (const v of [42002007, 42002008]) {
    await superusuario.query(
      "insert into acervo.versiculo (id, livro, capitulo, numero) values ($1, 42, 2, $2) on conflict do nothing",
      [v, v - 42002000],
    );
  }
  // A Fonte de teste (recorte do Josefo): integral, publicada, com o parágrafo 18.63 do derivado de fixture.
  const derivado = interpretarDerivado(
    JSON.parse(readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8")),
    "josefo-antiguidades.json",
  );
  const f = await superusuario.query<{ id: string }>(
    `insert into acervo.fonte (nivel, titulo, slug, tipo_texto, idioma, licenca, origem_url, publicada)
     values ('primaria', 'Antiguidades (teste)', 'josefo-antiguidades', 'integral', 'en', 'dominio-publico',
             'https://exemplo.invalid/o', true) returning id`,
  );
  const fonteId = (f.rows[0] as { id: string }).id;
  await superusuario.query(
    "insert into acervo.fonte_secao (id, fonte_id, ordem, titulo, slug) values ('josefo-antiguidades/18', $1, 18, 'Livro 18', '18')",
    [fonteId],
  );
  const paragrafo = derivado.secoes[0]?.paragrafos[0];
  if (!paragrafo) throw new Error("fixture sem parágrafo");
  await superusuario.query(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
     values ('josefo-antiguidades/18.63', 'josefo-antiguidades/18', 1, $1, '18.63', 'en')`,
    [paragrafo.texto],
  );
  // A ficha fictícia, carregada como rascunho (obra-de-teste: argumento-1 p. 10, trecho-1 p. xi-xii).
  await carregarRascunhos(
    [
      interpretarFichaYaml(
        readFileSync(path.join(PASTA_FICHAS, "obra-de-teste.yaml"), "utf8"),
        "obra-de-teste.yaml",
      ),
    ],
    { cliente: carga },
  );
  for (const [id, texto] of Object.entries(FRASES))
    await superusuario.query(
      "insert into acervo.afirmacao (id, texto, texto_hash, ordem) values ($1, $2, $3, 1)",
      [id, texto, sha(texto)],
    );
}, 180_000);

afterAll(async () => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
  if (emNeon()) return;
  for (const c of [carga, assistente, app, superusuario]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("a carga grava a proposta e as Citações, e é idempotente", () => {
  it("grava proposta_grau com o texto_hash do banco e as Citações com ordem, nos três alvos", async () => {
    await limpar();
    const r = await carregarPropostas(lerPropostasConferidas(PASTA_PROPOSTAS), { cliente: carga });
    // 4 propostas de grau + 5 Citações (a1: parágrafo e Passagem; a2: dois itens de ficha; a3: Passagem; a4: nenhuma).
    expect(r).toMatchObject({
      propostas: 4,
      inseridas: 4 + 2 + 2 + 1,
      atualizadas: 0,
      inalteradas: 0,
      removidas: 0,
      jaAprovadas: [],
      semCitacao: 1,
    });

    const graus = (
      await superusuario.query<{ afirmacao_id: string; grau_proposto: string; texto_hash: string }>(
        "select afirmacao_id, grau_proposto, texto_hash from acervo.proposta_grau order by afirmacao_id",
      )
    ).rows;
    expect(graus).toEqual([
      {
        afirmacao_id: "pc91-a1",
        grau_proposto: "posicao-majoritaria",
        texto_hash: sha(FRASES["pc91-a1"] as string),
      },
      {
        afirmacao_id: "pc91-a2",
        grau_proposto: "disputada",
        texto_hash: sha(FRASES["pc91-a2"] as string),
      },
      {
        afirmacao_id: "pc91-a3",
        grau_proposto: "consenso",
        texto_hash: sha(FRASES["pc91-a3"] as string),
      },
      {
        afirmacao_id: "pc91-a4",
        grau_proposto: "disputada",
        texto_hash: sha(FRASES["pc91-a4"] as string),
      },
    ]);

    const citacoes = (
      await superusuario.query(
        `select afirmacao_id, ordem, fonte_paragrafo_id, ficha_item_id, versiculo_inicio, versiculo_fim, trecho, idioma
           from acervo.citacao order by afirmacao_id, ordem`,
      )
    ).rows;
    expect(citacoes).toEqual([
      {
        afirmacao_id: "pc91-a1",
        ordem: 1,
        fonte_paragrafo_id: "josefo-antiguidades/18.63",
        ficha_item_id: null,
        versiculo_inicio: null,
        versiculo_fim: null,
        trecho: "a wise man, if it be lawful to call him a man",
        idioma: null,
      },
      {
        afirmacao_id: "pc91-a1",
        ordem: 2,
        fonte_paragrafo_id: null,
        ficha_item_id: null,
        versiculo_inicio: 42002007,
        versiculo_fim: 42002007,
        trecho: null,
        idioma: null,
      },
      {
        afirmacao_id: "pc91-a2",
        ordem: 1,
        fonte_paragrafo_id: null,
        ficha_item_id: "obra-de-teste/argumento-1",
        versiculo_inicio: null,
        versiculo_fim: null,
        trecho: null,
        idioma: null,
      },
      {
        afirmacao_id: "pc91-a2",
        ordem: 2,
        fonte_paragrafo_id: null,
        ficha_item_id: "obra-de-teste/trecho-1",
        versiculo_inicio: null,
        versiculo_fim: null,
        trecho: "invented test sentence",
        idioma: null,
      },
      {
        afirmacao_id: "pc91-a3",
        ordem: 1,
        fonte_paragrafo_id: null,
        ficha_item_id: null,
        versiculo_inicio: 42002007,
        versiculo_fim: 42002008,
        trecho: null,
        idioma: null,
      },
    ]);
    // Nenhuma aprovação foi gravada por esta carga.
    expect(await contar("select count(*)::int as n from acervo.aprovacao_afirmacao")).toBe(0);
  });

  it("a segunda carga devolve inseridas=0, atualizadas=0 e removidas=0; o comando relata a mesma coisa", async () => {
    await limpar();
    const primeira = await carregarPropostas(lerPropostasConferidas(PASTA_PROPOSTAS), {
      cliente: carga,
    });
    const idsAntes = (await superusuario.query("select id from acervo.citacao order by id")).rows;
    const segunda = await carregarPropostas(lerPropostasConferidas(PASTA_PROPOSTAS), {
      cliente: carga,
    });
    expect(primeira.inseridas).toBe(9);
    expect(segunda).toMatchObject({ inseridas: 0, atualizadas: 0, removidas: 0, inalteradas: 9 });
    // As Citações não foram regravadas: os ids são os mesmos.
    expect((await superusuario.query("select id from acervo.citacao order by id")).rows).toEqual(
      idsAntes,
    );

    // Pelo comando (executarRascunhos), com o cliente injetado.
    const saida: string[] = [];
    await executarRascunhos(
      { fichas: undefined, propostas: PASTA_PROPOSTAS },
      { abrir: () => conectar("carga"), escrever: (l) => saida.push(l) },
    );
    expect(saida).toContain(
      "propostas: inseridas=0 atualizadas=0 inalteradas=9 removidas=0 ja-aprovadas=0",
    );
  });

  it("proposta mudada troca só o que mudou: grau e justificativa atualizam; conjunto novo de Citações substitui o velho", async () => {
    await limpar();
    await carregarPropostas(lerPropostasConferidas(PASTA_PROPOSTAS), { cliente: carga });
    const mudada = pastaComTroca("grau_proposto: consenso", "grau_proposto: disputada");
    const r = await carregarPropostas(lerPropostasConferidas(mudada), { cliente: carga });
    expect(r).toMatchObject({ inseridas: 0, atualizadas: 1, removidas: 0 });
    const outro = pastaComTroca("      referencia: Lc 2:7-8\n", "      referencia: Lc 2:8\n");
    const r2 = await carregarPropostas(lerPropostasConferidas(outro), { cliente: carga });
    // pc91-a3 trocou a Passagem: sai 1 Citação e entra 1; o resto não mexe.
    expect(r2).toMatchObject({ inseridas: 1 + 0, atualizadas: 1, removidas: 1 });
    expect(
      (
        await superusuario.query(
          "select versiculo_inicio, versiculo_fim from acervo.citacao where afirmacao_id = 'pc91-a3'",
        )
      ).rows,
    ).toEqual([{ versiculo_inicio: 42002008, versiculo_fim: 42002008 }]);
  });

  it("sem pasta o comando sai 1; --propostas sem valor é uso errado; sem nenhuma pasta nada abre conexão", async () => {
    expect(() => lerOpcoes(["--propostas"], {})).toThrow(/Uso:/);
    expect(lerOpcoes([], {}).propostas).toBeUndefined();
    expect(lerOpcoes([], { ACERVO_PROPOSTAS_DIR: PASTA_PROPOSTAS }).propostas).toBe(
      PASTA_PROPOSTAS,
    );
    let abriu = false;
    await expect(
      executarRascunhos(
        { fichas: undefined, propostas: undefined },
        {
          abrir: async () => {
            abriu = true;
            throw new Error("não deveria abrir");
          },
        },
      ),
    ).rejects.toThrow(/--propostas/);
    expect(abriu).toBe(false);

    const env = { ...process.env };
    delete env.ACERVO_FICHAS_DIR;
    delete env.ACERVO_PROPOSTAS_DIR;
    for (const args of [[], ["--propostas"]]) {
      const r = spawnSync(
        "node_modules/.bin/tsx",
        ["scripts/acervo/carregar-rascunhos.ts", ...args],
        {
          cwd: RAIZ,
          env,
          encoding: "utf8",
        },
      );
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
    }
  });

  it("contrato ruim da pasta recusa ANTES de abrir conexão e sem gravar nada", async () => {
    const ruim = pastaComTroca("grau_proposto: consenso", "grau_proposto: certo");
    let abriu = false;
    await expect(
      executarRascunhos(
        { fichas: undefined, propostas: ruim },
        {
          abrir: async () => {
            abriu = true;
            throw new Error("não deveria abrir");
          },
        },
      ),
    ).rejects.toThrow(/propostas fora do contrato/);
    expect(abriu).toBe(false);
  });
});

describe.skipIf(emNeon())(
  "a proposta é invisível: só o Admin com segundo fator a lê (T-02-55)",
  () => {
    it("jnf_app sem sessão de Admin, o Assistente, o Estudante e o Admin sem segundo fator leem zero propostas e zero Citações", async () => {
      await limpar();
      await carregarPropostas(lerPropostasConferidas(PASTA_PROPOSTAS), { cliente: carga });
      const leitura = async (c: pg.Client, sessao: string | null) => {
        await c.query("begin");
        try {
          if (sessao !== null)
            await c.query("select set_config('app.sessao_admin', $1, true)", [sessao]);
          const g = await c.query("select count(*)::int as n from acervo.proposta_grau");
          const t = await c.query("select count(*)::int as n from acervo.citacao");
          return {
            propostas: (g.rows[0] as { n: number }).n,
            citacoes: (t.rows[0] as { n: number }).n,
          };
        } finally {
          await c.query("rollback");
        }
      };
      // Controle positivo do instrumento: o dono do banco e a carga enxergam o que foi gravado.
      expect(await contar("select count(*)::int as n from acervo.proposta_grau")).toBe(4);
      expect(await contar("select count(*)::int as n from acervo.citacao")).toBe(5);
      const nada = { propostas: 0, citacoes: 0 };
      expect(await leitura(app, null)).toEqual(nada);
      expect(await leitura(app, SEM_SESSAO)).toEqual(nada);
      expect(await leitura(app, sessoes.estudante)).toEqual(nada);
      expect(await leitura(app, sessoes["admin-sem-segundo-fator"])).toEqual(nada);
      expect(await leitura(assistente, null)).toEqual(nada);
      expect(await leitura(assistente, admin())).toEqual(nada);
      // O Admin com segundo fator lê tudo (a lista do dono, plano 21).
      expect(await leitura(app, admin())).toEqual({ propostas: 4, citacoes: 5 });
    });
  },
);

describe.skipIf(emNeon())("a carga não altera Afirmação com aprovação (T-02-56)", () => {
  it("a aprovada é relatada como já aprovada e nada dela muda; as outras seguem", async () => {
    await limpar();
    await carregarPropostas(lerPropostasConferidas(PASTA_PROPOSTAS), { cliente: carga });
    // O Admin com segundo fator aprova pc91-a1 (Fonte integral publicada e Passagem: os alvos sustentam).
    const hashes = (
      await superusuario.query<{ t: string; c: string }>(
        "select a.texto_hash as t, acervo.hash_citacoes(a.id) as c from acervo.afirmacao a where a.id = 'pc91-a1'",
      )
    ).rows[0] as { t: string; c: string };
    await app.query("select acervo.aprovar_afirmacao($1::uuid, 'pc91-a1', $2, 'consenso', $3)", [
      admin(),
      hashes.t,
      hashes.c,
    ]);
    const estado = async () => ({
      aprovacao: (
        await superusuario.query(
          "select * from acervo.aprovacao_afirmacao where afirmacao_id = 'pc91-a1'",
        )
      ).rows,
      proposta: (
        await superusuario.query(
          "select * from acervo.proposta_grau where afirmacao_id = 'pc91-a1'",
        )
      ).rows,
      citacoes: (
        await superusuario.query(
          "select * from acervo.citacao where afirmacao_id = 'pc91-a1' order by ordem",
        )
      ).rows,
    });
    const antes = await estado();
    expect(antes.aprovacao).toHaveLength(1);

    // Uma proposta MUDADA para a aprovada (outro grau, outra justificativa, uma Citação a menos) e para a outra.
    const pasta = mkdtempSync(path.join(tmpdir(), "jnf-propostas-"));
    temporarios.push(pasta);
    let yaml = readFileSync(path.join(PASTA_PROPOSTAS, "graus-propostos.yaml"), "utf8");
    yaml = yaml.replace("grau_proposto: posicao-majoritaria", "grau_proposto: disputada");
    yaml = yaml.replace("MARCADOR-JUSTIFICATIVA-PRIVADA", "OUTRA-JUSTIFICATIVA-MUDADA");
    yaml = yaml.replace(
      "    - alvo: passagem\n      referencia: Lc 2:7\n- afirmacao: pc91-a2",
      "- afirmacao: pc91-a2",
    );
    yaml = yaml.replace("grau_proposto: consenso", "grau_proposto: disputada"); // pc91-a3
    writeFileSync(path.join(pasta, "graus-propostos.yaml"), yaml);

    const r = await carregarPropostas(lerPropostasConferidas(pasta), { cliente: carga });
    expect(r.jaAprovadas).toEqual(["pc91-a1"]);
    expect(await estado()).toEqual(antes);
    // A outra Afirmação (pc91-a3) foi atualizada: a carga segue para o que não está aprovado.
    expect(r.atualizadas).toBe(1);
    expect(
      (
        await superusuario.query(
          "select grau_proposto from acervo.proposta_grau where afirmacao_id = 'pc91-a3'",
        )
      ).rows[0],
    ).toEqual({ grau_proposto: "disputada" });
    // E a aprovada continua valendo: o Estudante a lê.
    const lida = await app.query(
      "select count(*)::int as n from acervo.citacao where afirmacao_id = 'pc91-a1'",
    );
    expect((lida.rows[0] as { n: number }).n).toBe(2);
  });
});

describe.skipIf(emNeon())(
  "a carga recusa o que não confere com o banco, e não grava nada (all-or-nothing)",
  () => {
    const recusa = async (de: string, para: string, mensagem: RegExp) => {
      await limpar();
      const pasta = pastaComTroca(de, para);
      await expect(
        carregarPropostas(lerPropostasConferidas(pasta), { cliente: carga }),
      ).rejects.toThrow(mensagem);
      // Nada ficou: a primeira Afirmação (pc91-a1) está antes da ruim na ordem e foi desfeita.
      expect(await contar("select count(*)::int as n from acervo.proposta_grau")).toBe(0);
      expect(await contar("select count(*)::int as n from acervo.citacao")).toBe(0);
    };

    it("Afirmação que não existe no banco", async () => {
      await recusa(
        "afirmacao: pc91-a4",
        "afirmacao: pc91-a9",
        /pc91-a9: a Afirmação não existe no banco/,
      );
    });

    it("texto da Afirmação diferente do banco", async () => {
      await recusa(
        "texto: Frase sintética quatro, sem nenhuma Fonte do Acervo.",
        "texto: Frase sintética quatro, mas o Estudo mudou.",
        /pc91-a4: o texto da Afirmação no banco difere/,
      );
    });

    it("trecho de parágrafo que não é cópia literal do que está no banco", async () => {
      await recusa(
        "a wise man, if it be lawful to call him a man",
        "a wise man, if it be lawful to call him a prophet",
        /pc91-a1, Citação 1: o trecho não é cópia literal do parágrafo josefo-antiguidades\/18\.63/,
      );
    });

    it("parágrafo, item de ficha e versículo que não existem; página que a ficha não traz", async () => {
      await recusa(
        'ref: "18.63"',
        'ref: "18.99"',
        /o parágrafo josefo-antiguidades\/18\.99 não existe no banco/,
      );
      await recusa(
        "item: argumento-1",
        "item: argumento-7",
        /o item de ficha obra-de-teste\/argumento-7 não existe/,
      );
      await recusa("      pagina: 10\n", "      pagina: 11\n", /a página citada difere/);
      await recusa(
        "referencia: Lc 2:7-8",
        "referencia: Lc 2:9",
        /o versículo 42002009 não existe no banco/,
      );
    });
  },
);

describe.skipIf(emNeon())("o carregador de propostas não nomeia o que é do dono", () => {
  it("não cita as tabelas de aprovação nem a função de aprovar em SQL de escrita", () => {
    const fonte = readFileSync(
      path.join(RAIZ, "scripts", "acervo", "carregar-rascunhos.ts"),
      "utf8",
    );
    expect(fonte).not.toMatch(
      /(insert\s+into|update|delete\s+from)\s+(acervo\.)?aprovacao_afirmacao/i,
    );
    expect(fonte).not.toMatch(/acervo\.aprovar_afirmacao/);
  });
});
