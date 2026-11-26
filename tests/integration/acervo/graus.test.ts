import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { ErroDeBanco } from "@/db/erro-banco";
import { aprovarAfirmacao } from "@/modules/acervo/aprovacao";
import { lerPainelDeGraus } from "@/modules/acervo/consultas-graus";
import { lerLimite } from "@/modules/acervo/painel-graus";
import { interpretarFichaYaml } from "@/modules/acervo/schemas";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";
import { verificarFichaParaTeste } from "../../support/verificar-ficha-teste";

// O painel de graus propostos (ACER-06, ACER-10, D-04; plano 02-21): a leitura em um instantâneo, o estado de cada
// proposta concordando com a regra do banco (`acervo.aprovacao_vale`), o que cada papel enxerga, e a porta de aprovação
// com os hashes que a tela leu. Obra, Fonte, fichas e Citações são FICTÍCIAS e nenhum Grau real é aprovado: o banco é
// descartável SÓ deste arquivo e o teste não roda no Neon.

vi.mock("server-only", () => ({}));

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PASTA_FICHAS = path.join(RAIZ, "tests", "fixtures", "acervo", "rascunhos", "fichas");
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let dono: pg.Client;
let carga: pg.Client;
let cargaB: pg.Client;
const sessoes = {} as Record<CasoDeSessao, string>;
const admin = () => sessoes["admin-com-segundo-fator"];

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
let n = 0;
const proximo = () => ++n;

const hashDoTexto = async (a: string) =>
  (
    (await dono.query("select texto_hash from acervo.afirmacao where id = $1", [a])).rows[0] as {
      texto_hash: string;
    }
  ).texto_hash;
const hashDasCitacoes = async (a: string) =>
  ((await dono.query("select acervo.hash_citacoes($1) as h", [a])).rows[0] as { h: string }).h;
const vale = async (a: string) =>
  ((await dono.query("select acervo.aprovacao_vale($1) as v", [a])).rows[0] as { v: boolean }).v;
const aprovacoes = async (a: string) =>
  Number(
    (
      (
        await dono.query(
          "select count(*)::int as n from acervo.aprovacao_afirmacao where afirmacao_id = $1",
          [a],
        )
      ).rows[0] as { n: number }
    ).n,
  );

let estudoId: string;
let ordemDaAfirmacao = 0;

/** Uma Afirmação no Estudo de teste, com a proposta (hash de agora) e, se pedido, uma Citação de parágrafo de Fonte publicada. */
async function afirmacao(
  opcoes: { citar?: boolean; proposta?: boolean; hashVelho?: boolean; publicada?: boolean } = {},
) {
  const k = proximo();
  const id = `graus-a${k}`;
  await dono.query(
    "insert into acervo.afirmacao (id, estudo_id, texto, texto_hash, ordem) values ($1, $2, $3, $4, $5)",
    [id, estudoId, `Frase de teste ${k}`, sha(`texto-${k}`), ++ordemDaAfirmacao],
  );
  let paragrafo: string | null = null;
  let fonteSlug: string | null = null;
  if (opcoes.citar !== false) {
    fonteSlug = `graus-fonte-${k}`;
    const f = await dono.query<{ id: string }>(
      `insert into acervo.fonte (nivel, titulo, slug, tipo_texto, idioma, licenca, origem_url, publicada)
       values ('primaria', $1, $2, 'integral', 'en', 'dominio-publico', 'https://exemplo.invalid/o', $3) returning id`,
      [`Obra Fictícia ${k}`, fonteSlug, opcoes.publicada ?? true],
    );
    await dono.query(
      "insert into acervo.fonte_secao (id, fonte_id, ordem, titulo, slug) values ($1, $2, 1, 'Seção', 'secao')",
      [`${fonteSlug}/secao`, (f.rows[0] as { id: string }).id],
    );
    paragrafo = `${fonteSlug}/1.1`;
    await dono.query(
      `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
       values ($1, $2, 1, 'An invented sentence for a made-up source.', '1.1', 'en')`,
      [paragrafo, `${fonteSlug}/secao`],
    );
    await carga.query(
      `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
       values ($1, $2, 'An invented sentence', 'en', 1)`,
      [id, paragrafo],
    );
  }
  if (opcoes.proposta !== false) {
    await carga.query(
      `insert into acervo.proposta_grau (afirmacao_id, grau_proposto, justificativa, texto_hash)
       values ($1, 'consenso', 'Justificativa de teste.', $2)`,
      [id, opcoes.hashVelho ? "f".repeat(64) : await hashDoTexto(id)],
    );
  }
  return { id, paragrafo, fonteSlug };
}

/** Aprova pela porta que o painel usa, com os hashes ATUAIS (o que a tela leu), salvo o que for sobreposto. */
async function aprovar(
  a: string,
  grau: "consenso" | "posicao-majoritaria" | "disputada" = "consenso",
  hashes: { texto?: string; citacoes?: string } = {},
  sessao = admin(),
) {
  await aprovarAfirmacao(
    sessao,
    a,
    hashes.texto ?? (await hashDoTexto(a)),
    grau,
    hashes.citacoes ?? (await hashDasCitacoes(a)),
  );
}

async function fichaRascunho(): Promise<{ slug: string; item: string }> {
  const k = proximo();
  const slug = `graus-ficha-${k}`;
  const yaml = readFileSync(path.join(PASTA_FICHAS, "obra-de-teste.yaml"), "utf8").replace(
    /^slug: .*$/m,
    `slug: ${slug}`,
  );
  await carregarRascunhos([interpretarFichaYaml(yaml, `${slug}.yaml`)], { cliente: carga });
  const r = await dono.query<{ item: string }>(
    `select (select i.id from acervo.ficha_item i where i.ficha_id = o.id
              and (i.pagina_inicio is not null or i.pagina_texto is not null) order by i.tipo, i.ordem limit 1) as item
       from acervo.fonte o where o.slug = $1`,
    [slug],
  );
  return { slug, item: (r.rows[0] as { item: string }).item };
}

async function citarFicha(a: string, item: string, ordem = 1) {
  await carga.query(
    "insert into acervo.citacao (afirmacao_id, ficha_item_id, trecho, idioma, ordem) values ($1, $2, 'An invented line', 'en', $3)",
    [a, item, ordem],
  );
}

const painel = (
  filtro: "pendentes" | "aprovadas" | "todas" = "todas",
  ate = 400,
  sessao = admin(),
) => lerPainelDeGraus(sessao, filtro, ate);
const estadoDe = async (a: string) =>
  (await painel()).propostas.find((p) => p.afirmacaoId === a)?.estado;

// Os ids do cenário-base, preenchidos em `beforeAll`.
const base = {} as Record<"pendente" | "aprovada" | "aguardando" | "velho" | "semCitacao", string>;

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await dono.connect();
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  cargaB = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await cargaB.connect();
  for (const caso of [
    "admin-com-segundo-fator",
    "admin-sem-segundo-fator",
    "estudante",
    "geracao-antiga",
    "sessao-vencida",
  ] as const) {
    sessoes[caso] = (await criarSessaoDeTeste(dono, caso)).sessaoId;
  }
  await dono.query(
    "insert into acervo.livro (numero, nome, abreviacao, capitulos) values (42, 'Lucas', 'Lc', 24) on conflict do nothing",
  );
  await dono.query(
    "insert into acervo.versiculo (id, livro, capitulo, numero) values (42002007, 42, 2, 7) on conflict do nothing",
  );
  await dono.query(
    "insert into conteudo.trilha (id, nome, ordem, descricao) values ('trilha-graus', 'Trilha de teste', 9001, 'x')",
  );
  const e = await dono.query<{ id: string }>(
    `insert into conteudo.estudo (slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
     values ('estudo-graus', 'trilha-graus', 1, 'Estudo dos graus', 'historico', 'Corpo.', $1) returning id`,
    [sha("estudo-graus")],
  );
  estudoId = (e.rows[0] as { id: string }).id;

  // O cenário-base, ANTES de qualquer teste mexer: uma de cada estado, e uma sem Citação (não entra na lista).
  base.pendente = (await afirmacao()).id;
  base.aprovada = (await afirmacao()).id;
  await aprovar(base.aprovada, "disputada");
  const f = await fichaRascunho();
  base.aguardando = (await afirmacao({ citar: false })).id;
  await citarFicha(base.aguardando, f.item);
  base.velho = (await afirmacao({ hashVelho: true })).id;
  base.semCitacao = (await afirmacao({ citar: false })).id;
}, 180_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, cargaB, dono]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("a lista de propostas do Admin", () => {
  it("controle positivo: os quatro estados, a sem Citação fora da lista, e as contagens medidas do banco", async () => {
    const p = await painel("todas");
    const estados = new Map(p.propostas.map((x) => [x.afirmacaoId, x.estado]));
    expect(estados.get(base.pendente)).toBe("pendente");
    expect(estados.get(base.aprovada)).toBe("aprovada");
    expect(estados.get(base.aguardando)).toBe("aguardando-ficha");
    expect(estados.get(base.velho)).toBe("texto-mudou");
    // A proposta sem Citação não entra: não há o que aprovar.
    expect(estados.has(base.semCitacao)).toBe(false);
    expect(p.propostas).toHaveLength(4);
    expect(p.contagens).toEqual({ pendentes: 3, aprovadas: 1, todas: 4 });
    // A meta é medida: o total é o de Afirmações do banco (5), nunca um número escrito no código.
    expect(p.meta).toEqual({ aprovadas: 1, total: 5 });
    expect(p.restantes).toBe(0);
    const apr = p.propostas.find((x) => x.afirmacaoId === base.aprovada);
    expect(apr?.grauAprovado).toBe("disputada");
    expect(apr?.grauProposto).toBe("consenso");
    const agu = p.propostas.find((x) => x.afirmacaoId === base.aguardando);
    expect(agu?.fichasFaltando).toHaveLength(1);
    // Os hashes que a tela devolve ao aprovar são os atuais do banco.
    const pend = p.propostas.find((x) => x.afirmacaoId === base.pendente);
    expect(pend?.textoHash).toBe(await hashDoTexto(base.pendente));
    expect(pend?.citacoesHash).toBe(await hashDasCitacoes(base.pendente));
  });

  it("os filtros e a página concordam com as contagens (mesmo instantâneo); 'Mostrar mais' conta o que sobra", async () => {
    const pend = await painel("pendentes");
    expect(pend.propostas.map((x) => x.afirmacaoId).sort()).toEqual(
      [base.pendente, base.aguardando, base.velho].sort(),
    );
    expect(pend.contagens.pendentes).toBe(pend.propostas.length);
    const apr = await painel("aprovadas");
    expect(apr.propostas.map((x) => x.afirmacaoId)).toEqual([base.aprovada]);
    const duas = await painel("todas", 2);
    expect(duas.propostas).toHaveLength(2);
    expect(duas.restantes).toBe(2);
    expect(duas.contagens.todas).toBe(4);
    // `ate: 0` lê só as contagens (o que a entrada da administração usa).
    const so = await painel("pendentes", 0);
    expect(so.propostas).toEqual([]);
    expect(so.contagens).toEqual({ pendentes: 3, aprovadas: 1, todas: 4 });
  });

  it("a ordem é a do currículo (Estudo e Afirmação), não a de inserção do banco", async () => {
    const p = await painel("todas");
    const ordem = p.propostas.map((x) => x.afirmacaoId);
    expect(ordem).toEqual([base.pendente, base.aprovada, base.aguardando, base.velho]);
  });

  it.each([
    ["Estudante", "estudante"],
    ["Admin sem segundo fator", "admin-sem-segundo-fator"],
    ["geração antiga do segundo fator", "geracao-antiga"],
    ["sessão vencida", "sessao-vencida"],
  ] as const)("%s não lê nenhuma proposta nem aprovação (T-02-59)", async (_nome, caso) => {
    const p = await painel("todas", 400, sessoes[caso]);
    expect(p.propostas).toEqual([]);
    expect(p.contagens).toEqual({ pendentes: 0, aprovadas: 0, todas: 0 });
    // O total de Afirmações é público (é o corpo do Estudo); o que a sessão não vê é a aprovação.
    expect(p.meta.aprovadas).toBeGreaterThanOrEqual(0);
  });

  it("a sessão que não existe também lê zero", async () => {
    const p = await painel("todas", 400, "00000000-0000-4000-8000-0000000000aa");
    expect(p.propostas).toEqual([]);
  });

  it("monta as Citações propostas dos três alvos: Fonte, item de ficha com o estado da ficha, e Passagem", async () => {
    const a = await afirmacao();
    const f = await fichaRascunho();
    await citarFicha(a.id, f.item, 2);
    await carga.query(
      "insert into acervo.citacao (afirmacao_id, versiculo_inicio, versiculo_fim, ordem) values ($1, 42002007, 42002007, 3)",
      [a.id],
    );
    const p = (await painel()).propostas.find((x) => x.afirmacaoId === a.id);
    expect(p?.citacoes.map((c) => c.tipo)).toEqual(["paragrafo", "ficha", "passagem"]);
    const [par, fic, pas] = p?.citacoes ?? [];
    expect(par).toMatchObject({ tipo: "paragrafo", trecho: "An invented sentence", idioma: "en" });
    expect(fic).toMatchObject({ tipo: "ficha", verificada: false });
    expect(pas).toMatchObject({ tipo: "passagem", referencia: "Lucas 2:7" });
  });

  it("uma ficha verificada não é 'a conferir' e a Afirmação não espera", async () => {
    const f = await fichaRascunho();
    await verificarFichaParaTeste({ ...process.env, DATABASE_URL_OWNER: banco?.url }, f.slug);
    const a = await afirmacao({ citar: false });
    await citarFicha(a.id, f.item);
    const p = (await painel()).propostas.find((x) => x.afirmacaoId === a.id);
    expect(p?.estado).toBe("pendente");
    expect(p?.fichasFaltando).toEqual([]);
    expect(p?.citacoes[0]).toMatchObject({ tipo: "ficha", verificada: true });
  });
});

describe.skipIf(emNeon())(
  "o estado da tela concorda com a regra do banco (`aprovacao_vale`)",
  () => {
    async function concorda(a: string, esperado: string) {
      const estado = await estadoDe(a);
      expect(estado).toBe(esperado);
      // Aprovada na tela ⇔ a aprovação vale no banco: nunca uma sem a outra.
      expect(estado === "aprovada").toBe(await vale(a));
    }

    it("aprova, e depois cada mudança que o banco esconde a tira de 'aprovada' na tela também", async () => {
      // 1. Pendente, depois aprovada.
      const a = await afirmacao();
      await concorda(a.id, "pendente");
      await aprovar(a.id, "posicao-majoritaria");
      await concorda(a.id, "aprovada");

      // 2. O conjunto de Citações mudou depois da aprovação: volta a pendente.
      await carga.query(
        `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
       values ($1, $2, 'An invented', 'en', 2)`,
        [a.id, a.paragrafo],
      );
      await concorda(a.id, "pendente");
      await aprovar(a.id, "posicao-majoritaria");
      await concorda(a.id, "aprovada");

      // 3. A Fonte foi despublicada: a aprovação não vale; a tela não a mostra aprovada e diz qual Fonte falta.
      await dono.query("update acervo.fonte set publicada = false where slug = $1", [a.fonteSlug]);
      await concorda(a.id, "pendente");
      const p = (await painel()).propostas.find((x) => x.afirmacaoId === a.id);
      expect(p?.fontesFaltando).toHaveLength(1);
      await dono.query("update acervo.fonte set publicada = true where slug = $1", [a.fonteSlug]);
      await concorda(a.id, "aprovada");

      // 4. O texto mudou (a carga muda a frase; o hash é do banco): "Texto mudou", e a aprovação não vale.
      await dono.query("update acervo.afirmacao set texto = $2 where id = $1", [
        a.id,
        "outro texto",
      ]);
      await concorda(a.id, "texto-mudou");
    });

    it("ficha verificada que depois deixa de valer: 'Aguardando ficha', e a aprovação não vale", async () => {
      const f = await fichaRascunho();
      await verificarFichaParaTeste({ ...process.env, DATABASE_URL_OWNER: banco?.url }, f.slug);
      const a = await afirmacao({ citar: false });
      await citarFicha(a.id, f.item);
      await aprovar(a.id);
      await concorda(a.id, "aprovada");
      // A ficha muda (a tese; o gatilho recalcula o hash): a verificação antiga não vale mais para o hash atual.
      await dono.query(
        "update acervo.ficha set tese_pt = 'Tese reescrita depois da verificação.' where fonte_id = (select id from acervo.fonte where slug = $1)",
        [f.slug],
      );
      await concorda(a.id, "aguardando-ficha");
    });
  },
);

describe.skipIf(emNeon())("aprovar: a porta que o painel usa (hashes lidos, banco decide)", () => {
  it("controle positivo: grava o Grau escolhido (a correção) e o registro interno, com os hashes atuais", async () => {
    const a = await afirmacao();
    await aprovar(a.id, "disputada");
    const linha = (
      await dono.query(
        "select grau, texto_hash, citacoes_hash from acervo.aprovacao_afirmacao where afirmacao_id = $1",
        [a.id],
      )
    ).rows[0];
    expect(linha).toEqual({
      grau: "disputada",
      texto_hash: await hashDoTexto(a.id),
      citacoes_hash: await hashDasCitacoes(a.id),
    });
    expect((await painel()).propostas.find((x) => x.afirmacaoId === a.id)?.estado).toBe("aprovada");
  });

  it("texto velho e conjunto velho são recusados (40001), sem gravar", async () => {
    const a = await afirmacao();
    await expect(aprovar(a.id, "consenso", { texto: sha("lido-antes") })).rejects.toMatchObject({
      code: "40001",
    });
    await expect(aprovar(a.id, "consenso", { citacoes: sha("lido-antes") })).rejects.toMatchObject({
      code: "40001",
    });
    expect(await aprovacoes(a.id)).toBe(0);
  });

  it("Citação de ficha não verificada: recusa (P0003), sem gravar", async () => {
    const f = await fichaRascunho();
    const a = await afirmacao({ citar: false });
    await citarFicha(a.id, f.item);
    await expect(aprovar(a.id)).rejects.toMatchObject({ code: "P0003" });
    expect(await aprovacoes(a.id)).toBe(0);
  });

  it("sem Citação: recusa (P0002); Grau fora da lista: recusa (22023)", async () => {
    const sem = await afirmacao({ citar: false });
    await expect(aprovar(sem.id)).rejects.toMatchObject({ code: "P0002" });
    const a = await afirmacao();
    await expect(aprovar(a.id, "rejeitada" as unknown as "consenso")).rejects.toMatchObject({
      code: "22023",
    });
    expect(await aprovacoes(sem.id)).toBe(0);
    expect(await aprovacoes(a.id)).toBe(0);
  });

  it.each(["estudante", "admin-sem-segundo-fator", "geracao-antiga", "sessao-vencida"] as const)(
    "sessão de %s é recusada (42501), sem gravar",
    async (caso) => {
      const a = await afirmacao();
      const erro = await aprovar(a.id, "consenso", {}, sessoes[caso]).catch((e) => e);
      expect(erro).toBeInstanceOf(ErroDeBanco);
      expect((erro as ErroDeBanco).code).toBe("42501");
      expect(await aprovacoes(a.id)).toBe(0);
    },
  );

  it("o erro que sobe é sanitizado: só o código, sem a frase, o trecho nem a consulta", async () => {
    const a = await afirmacao();
    const erro = (await aprovar(a.id, "consenso", { texto: sha("x") }).catch((e) => e)) as Error;
    expect(erro).toBeInstanceOf(ErroDeBanco);
    expect(JSON.stringify(erro)).not.toContain("Frase de teste");
    expect(erro.message).not.toMatch(/select|acervo\.|Frase|invented/i);
  });
});

describe.skipIf(emNeon())(
  "paginação: além da primeira página, sem encolher a lista em silêncio",
  () => {
    it("'Mostrar mais' além do teto antigo: lerLimite('420') continua 420 e a leitura alcança a proposta além da primeira página", async () => {
      // 22 pendentes a mais: a última fica além da primeira página (20 por vez).
      const novos: string[] = [];
      for (let i = 0; i < 22; i++) novos.push((await afirmacao()).id);
      const alemDaPrimeira = novos[novos.length - 1] as string;

      // A primeira página, como a rota a lê do endereço sem `?ate=`.
      const primeira = await lerPainelDeGraus(admin(), "todas", lerLimite(undefined));
      expect(primeira.propostas).toHaveLength(20);
      expect(primeira.restantes).toBeGreaterThanOrEqual(2);
      expect(primeira.propostas.some((p) => p.afirmacaoId === alemDaPrimeira)).toBe(false);

      // O endereço que "Mostrar mais" gera a partir de ate=400: 420, além do teto antigo de 400. Antes do conserto,
      // lerLimite("420") valia 20 e as propostas além da primeira página ficavam inacessíveis.
      const ate420 = await lerPainelDeGraus(admin(), "todas", lerLimite("420"));
      expect(ate420.propostas).toHaveLength(ate420.contagens.todas); // todas, nunca 20
      expect(ate420.propostas.some((p) => p.afirmacaoId === alemDaPrimeira)).toBe(true);
      expect(ate420.restantes).toBe(0);
      // A ordem é estável: a página maior começa exatamente com a primeira página.
      expect(ate420.propostas.slice(0, 20).map((p) => p.afirmacaoId)).toEqual(
        primeira.propostas.map((p) => p.afirmacaoId),
      );
    });
  },
);

describe.skipIf(emNeon())(
  "corrida: a Citação muda enquanto o dono clica (FOR UPDATE no banco)",
  () => {
    async function esperarBloqueio(): Promise<void> {
      for (let i = 0; i < 100; i++) {
        const r = await dono.query(
          `select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and query like '%aprovar_afirmacao%' and pid <> pg_backend_pid()`,
        );
        if (r.rowCount) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("a aprovação não ficou esperando a trava");
    }

    it("controle positivo: uma mudança que NÃO confirma (rollback) não atrapalha a aprovação", async () => {
      const a = await afirmacao();
      const lidos = { texto: await hashDoTexto(a.id), citacoes: await hashDasCitacoes(a.id) };
      await cargaB.query("begin");
      await cargaB.query(
        `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
       values ($1, $2, 'An invented', 'en', 2)`,
        [a.id, a.paragrafo],
      );
      const aprovacao = aprovar(a.id, "consenso", lidos);
      await esperarBloqueio();
      await cargaB.query("rollback");
      await aprovacao;
      expect(await aprovacoes(a.id)).toBe(1);
    });

    it("a Citação nova que confirma antes da aprovação é vista: hash velho, recusa 40001, nada gravado", async () => {
      const a = await afirmacao();
      const lidos = { texto: await hashDoTexto(a.id), citacoes: await hashDasCitacoes(a.id) };
      await cargaB.query("begin");
      await cargaB.query(
        `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, trecho, idioma, ordem)
       values ($1, $2, 'An invented', 'en', 2)`,
        [a.id, a.paragrafo],
      );
      const aprovacao = aprovar(a.id, "consenso", lidos).catch((e) => e);
      await esperarBloqueio();
      await cargaB.query("commit");
      const erro = await aprovacao;
      expect(erro).toBeInstanceOf(ErroDeBanco);
      expect((erro as ErroDeBanco).code).toBe("40001");
      expect(await aprovacoes(a.id)).toBe(0);
    });
  },
);
