import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { aprovarAfirmacao } from "@/modules/acervo/aprovacao";
import { interpretarFichaYaml } from "@/modules/acervo/schemas";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import {
  abrirLeitura,
  abrirLeituraDoApp,
  abrirLeituraDoCarga,
  type ContagemDoAcervo,
  fecharLeitura,
  lerContagem,
  medirAcervo,
  renderizarContagem,
} from "../../../scripts/acervo/contar";
import { CAMINHO_LOCK } from "../../../scripts/acervo/derivados";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { criarSessaoDeTeste } from "../../support/sessao-admin-banco";
import { verificarFichaParaTeste } from "../../support/verificar-ficha-teste";

// A contagem medida do Acervo (ACER-11, D-09, D-22; plano 02-22): `pnpm acervo:count` lê o banco com DOIS papéis e
// imprime só números. O que o Estudante vê vem do papel do aplicativo (a política de linha decide) e o que existe vem
// do papel de carga; a Bíblia nunca é contada como Fonte (D-16); aprovação que deixou de valer não conta.
// Cenário do plano, num banco descartável SÓ deste arquivo: 2 Fontes publicadas de Níveis diferentes, 1 não publicada,
// 1 ficha verificada, 1 ficha em rascunho e 3 Afirmações, das quais 1 com aprovação válida.
// Toda obra, frase e justificativa é FICTÍCIA; nenhuma ficha real é tocada. O teste não roda no Neon.

vi.mock("server-only", () => ({}));

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FICHAS = path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let env: Record<string, string> = {};
let dono: pg.Client;
let carga: pg.Client;
let app: pg.Client;
const admin = { sessaoId: "" };

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

// Textos do cenário: nenhum deles pode aparecer na saída do comando.
const PRIMARIA = {
  slug: "conta-primaria",
  titulo: "Obra de Teste da Contagem Primária",
};
const NAO_PUBLICADA = {
  slug: "conta-nao-publicada",
  titulo: "Obra de Teste Ainda Não Publicada",
};
const FRASE = "Frase de teste da contagem";
const JUSTIFICATIVA = "Justificativa fictícia da contagem.";
const TEXTO_DA_FICHA = (
  interpretarFichaYaml(
    readFileSync(path.join(PASTA_FICHAS, "obra-de-teste.yaml"), "utf8"),
    "obra-de-teste.yaml",
  ) as { tese_pt: string }
).tese_pt;

const ids = { a1: "", a2: "", a3: "", fichaRascunho: "conta-ficha-rascunho", paragrafo: "" };

async function fonteIntegral(slug: string, titulo: string, publicada: boolean): Promise<string> {
  const f = await dono.query<{ id: string }>(
    `insert into acervo.fonte (nivel, titulo, slug, tipo_texto, idioma, licenca, origem_url, publicada)
     values ('primaria', $1, $2, 'integral', 'en', 'dominio-publico', 'https://exemplo.invalid/o', $3)
     returning id`,
    [titulo, slug, publicada],
  );
  return (f.rows[0] as { id: string }).id;
}

async function afirmacaoComCitacao(n: number): Promise<string> {
  const id = `conta-a${n}`;
  await dono.query(
    "insert into acervo.afirmacao (id, estudo_id, texto, texto_hash, ordem) values ($1, $2, $3, $4, $5)",
    [id, estudoId, `${FRASE} ${n}`, sha(`texto-${n}`), n],
  );
  await carga.query(
    `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
     values ($1, $2, 'An invented sentence for a made-up source.', 'en', 1)`,
    [id, ids.paragrafo],
  );
  return id;
}

const hashDoTexto = async (a: string) =>
  (
    (await dono.query("select texto_hash from acervo.afirmacao where id = $1", [a])).rows[0] as {
      texto_hash: string;
    }
  ).texto_hash;
const hashDasCitacoes = async (a: string) =>
  ((await dono.query("select acervo.hash_citacoes($1) as h", [a])).rows[0] as { h: string }).h;

/** Aprova pela porta que o painel usa, com os hashes ATUAIS (o que a tela leu). */
async function aprovar(a: string): Promise<void> {
  await aprovarAfirmacao(
    admin.sessaoId,
    a,
    await hashDoTexto(a),
    "consenso",
    await hashDasCitacoes(a),
  );
}

async function fichaRascunho(slug: string): Promise<void> {
  const yaml = readFileSync(path.join(PASTA_FICHAS, "obra-de-teste.yaml"), "utf8").replace(
    /^slug: .*$/m,
    `slug: ${slug}`,
  );
  await carregarRascunhos([interpretarFichaYaml(yaml, `${slug}.yaml`)], { cliente: carga });
}

let estudoId = "";

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  env = preparado.env;
  Object.assign(process.env, env);
  dono = new pg.Client({ connectionString: banco.url });
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }, env) });
  app = new pg.Client({ connectionString: urlDoPapel("app", { agrupada: false }, env) });
  await Promise.all([dono.connect(), carga.connect(), app.connect()]);
  admin.sessaoId = (await criarSessaoDeTeste(dono, "admin-com-segundo-fator")).sessaoId;

  await dono.query(
    "insert into conteudo.trilha (id, nome, ordem, descricao) values ('trilha-conta', 'Trilha de teste', 9101, 'x')",
  );
  const e = await dono.query<{ id: string }>(
    `insert into conteudo.estudo (slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
     values ('estudo-conta', 'trilha-conta', 1, 'Estudo da contagem', 'historico', 'Corpo.', $1)
     returning id`,
    [sha("estudo-conta")],
  );
  estudoId = (e.rows[0] as { id: string }).id;

  // 2 Fontes de texto integral: uma publicada (com um parágrafo, alvo da Citação) e uma não publicada.
  const idPrimaria = await fonteIntegral(PRIMARIA.slug, PRIMARIA.titulo, true);
  await fonteIntegral(NAO_PUBLICADA.slug, NAO_PUBLICADA.titulo, false);
  await dono.query(
    "insert into acervo.fonte_secao (id, fonte_id, ordem, titulo, slug) values ($1, $2, 1, 'Seção', 'secao')",
    [`${PRIMARIA.slug}/secao`, idPrimaria],
  );
  ids.paragrafo = `${PRIMARIA.slug}/1.1`;
  await dono.query(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
     values ($1, $2, 1, 'An invented sentence for a made-up source.', '1.1', 'en')`,
    [ids.paragrafo, `${PRIMARIA.slug}/secao`],
  );

  // 1 ficha verificada (pelas funções reais do banco) e 1 ficha em rascunho: as duas são da Pesquisa acadêmica.
  await fichaRascunho("conta-ficha-verificada");
  await verificarFichaParaTeste(
    { ...process.env, DATABASE_URL_OWNER: banco.url },
    "conta-ficha-verificada",
  );
  await fichaRascunho(ids.fichaRascunho);

  // 3 Afirmações: duas com Citação (aprovadas) e uma sem Citação.
  ids.a1 = await afirmacaoComCitacao(1);
  ids.a2 = await afirmacaoComCitacao(2);
  ids.a3 = `conta-a3`;
  await dono.query(
    "insert into acervo.afirmacao (id, estudo_id, texto, texto_hash, ordem) values ($1, $2, $3, $4, 3)",
    [ids.a3, estudoId, `${FRASE} 3`, sha("texto-3")],
  );
  await aprovar(ids.a1);
  await aprovar(ids.a2);
  // Uma proposta para cada Afirmação com Citação, com o hash do texto de agora.
  for (const a of [ids.a1, ids.a2]) {
    await carga.query(
      "insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash) values ($1, 'consenso', $2, $3)",
      [a, JUSTIFICATIVA, await hashDoTexto(a)],
    );
  }
}, 180_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [app, carga, dono]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

/** A gramática inteira da saída: nada fora destas formas pode ser impresso. */
const GRAMATICA = [
  /^CONTAGEM_ACERVO data=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ambiente=(dev|producao)$/,
  /^FONTES_PUBLICADAS primaria=\d+ academica=\d+ confessional=\d+$/,
  /^FONTES_NAO_PUBLICADAS \d+$/,
  /^FICHAS_VERIFICADAS \d+$/,
  /^FICHAS_RASCUNHO \d+$/,
  /^AFIRMACOES_COM_CITACAO_APROVADA \d+ DE \d+$/,
  /^PROPOSTAS_PENDENTES \d+$/,
  /^DECLARADO fontes_primarias_publicadas=\d+ fichas_verificadas=\d+ — meta: cerca de 40 Fontes primárias e cerca de 25 fichas verificadas$/,
  /^TABELA [a-z_]+ bytes=\d+$/,
  /^TABELAS_TOTAL bytes=\d+$/,
  /^DERIVADOS_VERSIONADOS arquivos=\d+ soma_bytes=\d+ orcamento_total_bytes=\d+ razao=\d+\.\d{4}$/,
];
// Toda palavra que a saída pode ter, além dos nomes das tabelas do esquema acervo.
const LINGUAGEM_FIXA = [
  "CONTAGEM",
  "ACERVO",
  "data",
  "ambiente",
  "dev",
  "FONTES",
  "PUBLICADAS",
  "primaria",
  "academica",
  "confessional",
  "NAO",
  "FICHAS",
  "VERIFICADAS",
  "RASCUNHO",
  "AFIRMACOES",
  "COM",
  "CITACAO",
  "APROVADA",
  "DE",
  "PROPOSTAS",
  "PENDENTES",
  "DECLARADO",
  "fontes",
  "primarias",
  "publicadas",
  "fichas",
  "verificadas",
  "meta",
  "cerca",
  "de",
  "Fontes",
  "primárias",
  "e",
  "TABELA",
  "bytes",
  "TABELAS",
  "TOTAL",
  "DERIVADOS",
  "VERSIONADOS",
  "arquivos",
  "soma",
  "orcamento",
  "total",
  "razao",
];

const medir = (tamanho = false) => medirAcervo({ app, carga, tamanho });
const linhasDe = (m: ContagemDoAcervo & { data: string }) => renderizarContagem(m);

describe.skipIf(emNeon())("acervo:count traz as contagens medidas do banco", () => {
  it("controle positivo: as duas aprovações valem antes de qualquer mudança", async () => {
    const m = await medir();
    expect(m.afirmacoesAprovadas).toBe(2);
    expect(m.propostasPendentes).toBe(0);
    const linhas = linhasDe(m).filter((l) => /^(AFIRMACOES|PROPOSTAS)/.test(l));
    expect(linhas).toEqual(["AFIRMACOES_COM_CITACAO_APROVADA 2 DE 3", "PROPOSTAS_PENDENTES 0"]);
  });

  it("a aprovação que deixou de valer (o texto da Afirmação mudou) não conta como aprovada", async () => {
    // Como a carga mudaria a frase: o texto e o hash do texto mudam, e a aprovação gravada fica com o hash velho.
    await carga.query("update acervo.afirmacao set texto = $2, texto_hash = $3 where id = $1", [
      ids.a2,
      `${FRASE} 2 reescrita`,
      sha("texto-2-reescrito"),
    ]);
    const m = await medir();
    expect(m.afirmacoesAprovadas).toBe(1);
    expect(m.afirmacoesTotal).toBe(3);
    // A proposta da Afirmação sem aprovação válida volta a esperar o dono; a da aprovada, não.
    expect(m.propostasPendentes).toBe(1);
    // Controle: a linha da aprovação velha continua no banco; é a regra do banco que a desconta.
    const gravadas = await dono.query("select count(*)::int as n from acervo.aprovacao_afirmacao");
    expect(Number((gravadas.rows[0] as { n: number }).n)).toBe(2);
  });

  it("a saída traz exatamente as contagens do cenário, uma por linha", async () => {
    const m = await medir();
    expect(linhasDe(m)).toEqual([
      expect.stringMatching(/^CONTAGEM_ACERVO data=.+ ambiente=dev$/),
      "FONTES_PUBLICADAS primaria=1 academica=1 confessional=0",
      "FONTES_NAO_PUBLICADAS 1",
      "FICHAS_VERIFICADAS 1",
      "FICHAS_RASCUNHO 1",
      "AFIRMACOES_COM_CITACAO_APROVADA 1 DE 3",
      "PROPOSTAS_PENDENTES 1",
      "DECLARADO fontes_primarias_publicadas=1 fichas_verificadas=1 — meta: cerca de 40 Fontes primárias e cerca de 25 fichas verificadas",
    ]);
  });

  it("o que o Estudante vê vem do papel do aplicativo e o que existe do papel de carga", async () => {
    // Direto do banco, por papel. O que existe (carga): 1 texto integral publicada, 1 não publicada e 2 fichas = 4.
    // O Estudante (aplicativo) não vê a Fonte não publicada nem a ficha em rascunho: 1 texto integral e 1 ficha.
    const comoApp = await app.query<{ fontes: number; fichas: number }>(
      `select (select count(*)::int from acervo.fonte) as fontes,
              (select count(*)::int from acervo.fonte where tipo_texto = 'ficha') as fichas`,
    );
    const comoCarga = await carga.query<{ fontes: number; fichas: number }>(
      `select (select count(*)::int from acervo.fonte) as fontes,
              (select count(*)::int from acervo.fonte where tipo_texto = 'ficha') as fichas`,
    );
    expect(comoApp.rows[0]).toEqual({ fontes: 2, fichas: 1 });
    expect(comoCarga.rows[0]).toEqual({ fontes: 4, fichas: 2 });
    // A ficha em rascunho só aparece na leitura do que existe.
    const m = await medir();
    expect(m.fichasVerificadas).toBe(1);
    expect(m.fichasRascunho).toBe(1);
    expect(m.fontesPublicadas).toEqual({ primaria: 1, academica: 1, confessional: 0 });
  });

  it("controle negativo: lido com os papéis trocados, o Estudante vê mais ficha do que existe e a contagem se recusa", async () => {
    // O papel de carga vê as duas fichas e o do aplicativo, uma: trocados, "o que o Estudante vê" (2) passa do que
    // "existe" (1). A recusa é o que impede uma conta incoerente de sair como se fosse medida.
    await expect(medirAcervo({ app: carga, carga: app })).rejects.toThrow(/discordam/);
  });

  it("a Bíblia nunca é contada como Fonte (D-16)", async () => {
    const antes = await medir();
    await dono.query(
      "insert into acervo.conjunto_dados (id, nome, versao, commit, licenca, url_licenca, sha256_lock) values ('conta-biblia', 'Conjunto de teste', '1', 'c', 'l', 'https://exemplo.invalid/', $1)",
      [sha("lock")],
    );
    await dono.query(
      "insert into acervo.livro (numero, nome, abreviacao, capitulos) values (43, 'João', 'Jo', 21)",
    );
    await dono.query(
      "insert into acervo.versiculo (id, livro, capitulo, numero) values (43001001, 43, 1, 1)",
    );
    await dono.query(
      "insert into acervo.texto (id, conjunto_id, edicao, nome) values ('conta-texto', 'conta-biblia', 'n4', 'Texto de teste')",
    );
    await dono.query(
      "insert into acervo.texto_versiculo (texto_id, versiculo_id, conteudo, conteudo_hash) values ('conta-texto', 43001001, 'Versículo de teste da contagem.', $1)",
      [sha("versiculo")],
    );
    // Controle positivo: a Bíblia está no banco (as quatro tabelas dela têm linha).
    const linhas = await dono.query<{ n: number }>(
      `select (select count(*)::int from acervo.livro)
            + (select count(*)::int from acervo.versiculo)
            + (select count(*)::int from acervo.texto)
            + (select count(*)::int from acervo.texto_versiculo) as n`,
    );
    expect(Number((linhas.rows[0] as { n: number }).n)).toBe(4);
    const depois = await medir();
    const { data: _d1, ...a } = antes;
    const { data: _d2, ...d } = depois;
    expect(d).toEqual(a);
  });

  it("nenhum texto de Fonte, de ficha ou de Afirmação sai: só números, nomes de tabela e o texto fixo", async () => {
    const saida = linhasDe(await medir(true));
    for (const linha of saida) {
      const casa = GRAMATICA.filter((g) => g.test(linha));
      expect(casa, `linha fora da gramática: ${linha}`).toHaveLength(1);
    }
    const tudo = saida.join("\n");
    for (const texto of [
      PRIMARIA.titulo,
      NAO_PUBLICADA.titulo,
      FRASE,
      JUSTIFICATIVA,
      TEXTO_DA_FICHA,
      "An invented sentence",
      "Versículo de teste",
      PRIMARIA.slug,
      NAO_PUBLICADA.slug,
      ids.fichaRascunho,
      "conta-ficha-verificada",
      ids.a1,
    ]) {
      // Sem imprimir o valor no caso de falha: a asserção é sobre um booleano.
      expect(tudo.includes(texto)).toBe(false);
    }
    // Nenhuma credencial: sem URL de conexão e sem nenhuma das senhas aleatórias da execução.
    expect(tudo).not.toMatch(/postgres(ql)?:\/\//);
    for (const nome of [
      "JNF_APP_PASSWORD",
      "JNF_MIGRA_PASSWORD",
      "JNF_CARGA_PASSWORD",
      "JNF_ASSISTENTE_PASSWORD",
    ] as const) {
      expect(tudo.includes(env[nome] as string)).toBe(false);
    }
    // O que há de palavra na saída é só a linguagem fixa do comando e nomes de tabela do esquema acervo.
    const catalogo = await dono.query<{ relname: string }>(
      "select relname from pg_class where relnamespace = 'acervo'::regnamespace and relkind = 'r'",
    );
    const nomesDeTabela = new Set(catalogo.rows.flatMap((r) => r.relname.split("_")));
    const semData = tudo.replace(/data=\S+/, "data=");
    const palavras = new Set(semData.split(/[^A-Za-zÀ-ÿ]+/).filter(Boolean));
    expect(
      [...palavras].filter((p) => !LINGUAGEM_FIXA.includes(p) && !nomesDeTabela.has(p)),
    ).toEqual([]);
  });
});

describe.skipIf(emNeon())("as duas leituras saem de UM instantâneo", () => {
  const outro = async (papel: "app" | "carga") => {
    const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }, env) });
    await c.connect();
    return c;
  };

  it("a leitura do aplicativo entra no instantâneo exportado pela carga, mesmo com escrita confirmada no meio", async () => {
    const carga2 = await outro("carga");
    const app2 = await outro("app");
    try {
      // 1. A carga abre e exporta.
      const instantaneo = await abrirLeituraDoCarga(carga2);
      // 2. Uma escrita confirma DEPOIS do instantâneo exportado e ANTES de o aplicativo abrir a leitura dele.
      await dono.query("update acervo.fonte set publicada = true where slug = $1", [
        NAO_PUBLICADA.slug,
      ]);
      // 3. O aplicativo importa o MESMO instantâneo.
      await abrirLeituraDoApp(app2, instantaneo);
      const visto = await app2.query<{ n: number }>(
        "select count(*)::int as n from acervo.fonte where tipo_texto = 'integral'",
      );
      // Vê o estado de antes da escrita (2 não; 1 publicada de texto integral), não o de depois.
      expect(Number((visto.rows[0] as { n: number }).n)).toBe(1);
      const pelaCarga = await carga2.query<{ n: number }>(
        "select count(*)::int as n from acervo.fonte where tipo_texto = 'integral' and not publicada",
      );
      expect(Number((pelaCarga.rows[0] as { n: number }).n)).toBe(1);
      await fecharLeitura(carga2, app2);
      // Controle positivo: fora do instantâneo, uma leitura nova vê a escrita.
      const fora = await app2.query<{ n: number }>(
        "select count(*)::int as n from acervo.fonte where tipo_texto = 'integral'",
      );
      expect(Number((fora.rows[0] as { n: number }).n)).toBe(2);
    } finally {
      await fecharLeitura(carga2, app2);
      await app2.end().catch(() => {});
      await carga2.end().catch(() => {});
      await dono.query("update acervo.fonte set publicada = false where slug = $1", [
        NAO_PUBLICADA.slug,
      ]);
    }
  });

  it("a leitura aberta não muda com escrita confirmada durante ela; reaberta, vê o estado novo", async () => {
    const carga2 = await outro("carga");
    const app2 = await outro("app");
    try {
      await abrirLeitura(carga2, app2);
      await dono.query("update acervo.fonte set publicada = true where slug = $1", [
        NAO_PUBLICADA.slug,
      ]);
      const durante = await lerContagem(app2, carga2);
      expect(durante.fontesNaoPublicadas).toBe(1);
      expect(durante.fontesPublicadas.primaria).toBe(1);
      await fecharLeitura(carga2, app2);
      const depois = await medirAcervo({ app: app2, carga: carga2 });
      expect(depois.fontesNaoPublicadas).toBe(0);
      expect(depois.fontesPublicadas.primaria).toBe(2);
    } finally {
      await fecharLeitura(carga2, app2);
      await app2.end().catch(() => {});
      await carga2.end().catch(() => {});
      await dono.query("update acervo.fonte set publicada = false where slug = $1", [
        NAO_PUBLICADA.slug,
      ]);
    }
  });
});

describe.skipIf(emNeon())("acervo:count --tamanho", () => {
  it("mede cada tabela do esquema acervo, o total e os derivados versionados contra o orçamento", async () => {
    expect(medir).toBeDefined();
    const m = await medir(true);
    expect(m.tamanho).toBeDefined();
    const linhas = linhasDe(m);
    // As tabelas vêm do catálogo: a lista do comando é a lista do esquema.
    const catálogo = await dono.query<{ relname: string }>(
      "select relname from pg_class where relnamespace = 'acervo'::regnamespace and relkind = 'r' order by relname",
    );
    const nomes = catálogo.rows.map((r) => r.relname);
    const medidos = linhas.filter((l) => l.startsWith("TABELA "));
    expect(medidos.map((l) => l.split(" ")[1])).toEqual(nomes);
    // Independente do comando: o tamanho medido direto no banco.
    const direto = await dono.query<{ relname: string; bytes: number }>(
      "select c.relname, pg_total_relation_size(c.oid)::bigint as bytes from pg_class c where c.relnamespace = 'acervo'::regnamespace and c.relkind = 'r' order by c.relname",
    );
    for (const l of medidos) {
      const [nome, bytes] = [l.split(" ")[1] as string, Number(l.split("bytes=")[1])];
      const esperado = direto.rows.find((r) => r.relname === nome);
      expect(bytes, nome).toBe(Number(esperado?.bytes));
    }
    // As quatro mesmas do teste de latência (plano 02-07): o que o Acervo tem de maior.
    for (const nome of ["fonte", "fonte_secao", "fonte_paragrafo", "ficha", "ficha_item"]) {
      expect(nomes).toContain(nome);
    }
    const total = linhas.find((l) => l.startsWith("TABELAS_TOTAL "));
    const soma = direto.rows.reduce((s, r) => s + Number(r.bytes), 0);
    expect(total).toBe(`TABELAS_TOTAL bytes=${soma}`);
    // Os derivados: a soma e o orçamento são lidos do lock versionado.
    const lock = JSON.parse(readFileSync(CAMINHO_LOCK, "utf8")) as {
      orcamento_total_bytes: number;
      derivados: Record<string, { bytes: number }>;
    };
    const somaDosDerivados = Object.values(lock.derivados).reduce((s, d) => s + d.bytes, 0);
    const linha = linhas.find((l) => l.startsWith("DERIVADOS_VERSIONADOS "));
    expect(linha).toBe(
      `DERIVADOS_VERSIONADOS arquivos=${Object.keys(lock.derivados).length} soma_bytes=${somaDosDerivados} orcamento_total_bytes=${lock.orcamento_total_bytes} razao=${(somaDosDerivados / lock.orcamento_total_bytes).toFixed(4)}`,
    );
    // Sem --tamanho nenhuma linha de tamanho sai.
    const sem = linhasDe(await medir(false));
    expect(sem.filter((l) => /^(TABELA|DERIVADOS)/.test(l))).toEqual([]);
  });
});
