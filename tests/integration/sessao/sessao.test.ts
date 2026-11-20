import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { comEstudante } from "@/db/com-estudante";
import { usuario } from "@/db/schema/fundacao";
import { sessao } from "@/db/schema/sessao";
import { urlDoPapel } from "@/db/url";
import { exportarDados } from "@/modules/privacidade/exportar";
import { removerConta } from "@/modules/privacidade/remover-conta";
import { ANOTACAO_DA_SESSAO_MAX } from "@/modules/sessao/anotacao";
import {
  abrirSessao,
  encerrarSessao,
  faixaDaSessao,
  historicoSessoes,
  sessaoAberta,
} from "@/modules/sessao/consultas";
import { iniciarNovaVolta } from "@/modules/trilhas/consultas";
import { registrarPosicao } from "@/modules/trilhas/posicao";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Sessão (TRIL-03): dado privado do Estudante, incluindo a Anotação da Sessão (D-10). Este arquivo cria e
// usa um banco descartável SÓ dele (o compartilhado é contado por outros testes e Estudos criados aqui
// o fariam variar). O bloco do catálogo é só leitura e roda também no Neon; o resto cria linhas e não roda lá.

const emNeon = () => inject("alvoBanco") === "neon";

const rodada = randomUUID();
const trilhaA = `trilha-sessao-a-${rodada.slice(0, 8)}`;
const trilhaB = `trilha-sessao-b-${rodada.slice(0, 8)}`;
const HASH = createHash("sha256").update(rodada).digest("hex");
// Três Estudos: dois na primeira Trilha (ordem 1 e 2), um na segunda.
const estudos = [
  { id: randomUUID(), slug: `sessao-a1-${rodada}`, titulo: `Estudo A1 ${rodada.slice(0, 6)}` },
  { id: randomUUID(), slug: `sessao-a2-${rodada}`, titulo: `Estudo A2 ${rodada.slice(0, 6)}` },
  { id: randomUUID(), slug: `sessao-b1-${rodada}`, titulo: `Estudo B1 ${rodada.slice(0, 6)}` },
] as const;
const [e1, e2, e3] = estudos;
let banco: BancoDeExecucao | undefined;

async function comoCarga<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

// Dono do banco descartável: ignora a RLS e serve de "contagem verdadeira".
async function comoDono<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

const sessoesReais = (estudante: string) =>
  comoDono(async (c) => {
    const r = await c.query(
      `select count(*)::int as n from privado.sessao where estudante_id = $1`,
      [estudante],
    );
    return r.rows[0]?.n as number;
  });

const codigoDe = (erro: unknown) =>
  (erro as { code?: string; cause?: { code?: string } }).code ??
  (erro as { cause?: { code?: string } }).cause?.code;

async function novaConta(): Promise<string> {
  const id = randomUUID();
  await obterDb()
    .insert(usuario)
    .values({ id, email: `s-${id}@example.test` });
  return id;
}

const dormir = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

// Uma porta que faz o trabalho, avisa que gravou e SEGURA a transação aberta até alguém soltar. Prova a
// fila sem laço de repetição: a segunda operação, com a primeira segurando a trava, não pode terminar.
function comPortao() {
  let soltar = () => {};
  const portao = new Promise<void>((r) => {
    soltar = r;
  });
  let gravou = () => {};
  const jaGravou = new Promise<void>((r) => {
    gravou = r;
  });
  const porta: typeof comEstudante = (id, fn) =>
    comEstudante(id, async (tx) => {
      const r = await fn(tx);
      gravou();
      await portao;
      return r;
    });
  return { porta, jaGravou, soltar };
}

// Observa uma promessa sem esperá-la: devolve uma função que diz se ela já terminou.
function observar<T>(promessa: Promise<T>): () => boolean {
  let terminou = false;
  promessa.then(
    () => {
      terminou = true;
    },
    () => {
      terminou = true;
    },
  );
  return () => terminou;
}

// O tempo que a segunda operação tem para (erradamente) passar na frente da primeira. É o mesmo prazo
// que o plano 01-13 usou; a prova não depende do prazo ser longo, e sim do controle positivo: depois de
// soltar, a segunda termina e o resultado é o da ordem da fila.
const ESPERA_DA_FILA_MS = 400;

// A aba só pode pedir o check-out da Sessão que ela MOSTRA: o id é o da Sessão aberta que a tela lê agora.
// Sem Sessão aberta a aba manda um id que não é de Sessão nenhuma (nada a encerrar).
async function encerrarDaTela(
  estudanteId: string,
  entrada: Omit<Parameters<typeof encerrarSessao>[1], "sessaoId">,
  extra?: Parameters<typeof encerrarSessao>[2],
) {
  const sessaoId = (await sessaoAberta(estudanteId))?.id ?? randomUUID();
  return encerrarSessao(estudanteId, { ...entrada, sessaoId }, extra);
}

beforeAll(async () => {
  if (emNeon()) {
    aplicarEnvDeTeste();
    return;
  }
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  await comoCarga(async (c) => {
    await c.query(
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, 1, 'x'), ($3, $4, 2, 'x')",
      [trilhaA, `Trilha A ${rodada}`, trilhaB, `Trilha B ${rodada}`],
    );
    const linhas: [(typeof estudos)[number], string, number][] = [
      [e1, trilhaA, 1],
      [e2, trilhaA, 2],
      [e3, trilhaB, 1],
    ];
    for (const [e, trilha, ordem] of linhas) {
      await c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, $4, $5, 'devocional', 'x', $6)`,
        [e.id, e.slug, trilha, ordem, e.titulo, HASH],
      );
    }
  });
});

afterAll(async () => {
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe("catálogo: privado.sessao é protegida (só leitura, vale também no Neon)", () => {
  it("RLS ativa e forçada, uma política por identidade, cascata, uma Sessão aberta por índice e nenhuma restrição de verificação", async () => {
    const tabela = await obterPool().query<{
      ativa: boolean;
      forca: boolean;
      politicas: number;
      expressoes: string[];
      cascata: boolean;
      dono: string;
      checks: number;
    }>(`
      select c.relrowsecurity as ativa, c.relforcerowsecurity as forca,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as politicas,
             coalesce((select array_agg(pg_get_expr(p.polqual, p.polrelid)) from pg_policy p
                       where p.polrelid = c.oid), '{}') as expressoes,
             exists (
               select 1 from pg_constraint k
               join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
               where k.conrelid = c.oid and k.contype = 'f'
                 and k.confrelid = 'auth."user"'::regclass and k.confdeltype = 'c'
                 and a.attname = 'estudante_id') as cascata,
             pg_get_userbyid(c.relowner) as dono,
             (select count(*)::int from pg_constraint k where k.conrelid = c.oid and k.contype = 'c') as checks
      from pg_class c where c.oid = 'privado.sessao'::regclass`);
    const t = tabela.rows[0];
    // Controle: a consulta achou a tabela (não passa por estar vazia).
    expect(t).toBeDefined();
    expect(t?.ativa).toBe(true);
    expect(t?.forca).toBe(true);
    expect(t?.politicas).toBe(1);
    expect(t?.expressoes.every((e) => e.includes("app.estudante_id"))).toBe(true);
    expect(t?.cascata).toBe(true);
    expect(t?.dono).toBe("jnf_migra");
    // Nenhuma restrição de verificação: o banco repetiria a linha (e a Anotação) numa violação.
    expect(t?.checks).toBe(0);

    const indice = await obterPool().query<{ definicao: string }>(
      `select pg_get_indexdef(i.indexrelid) as definicao
       from pg_index i where i.indrelid = 'privado.sessao'::regclass and i.indisunique and not i.indisprimary`,
    );
    expect(indice.rows).toHaveLength(1);
    expect(indice.rows[0]?.definicao).toMatch(/\(estudante_id\)/);
    expect(indice.rows[0]?.definicao.toLowerCase()).toContain("where (check_out_em is null)");
  });
});

describe.skipIf(emNeon())("privado.sessao: cada conta vê só as suas Sessões", () => {
  it("a Sessão de A, com a Anotação, é invisível para B, ao lado do controle positivo de A", async () => {
    const a = await novaConta();
    const b = await novaConta();
    const segredo = `anotacao-privada-de-a-${rodada}`;
    expect((await abrirSessao(a, { estudoSlug: e1.slug })).ok).toBe(true);
    const fechada = await encerrarDaTela(a, { estudoSlugAtual: e2.slug, anotacao: segredo });
    expect(fechada).toMatchObject({ ok: true, de: e1.titulo, ate: e2.titulo });

    // Controle positivo: A vê a dela, com a Anotação.
    const deA = await historicoSessoes(a);
    expect(deA).toHaveLength(1);
    expect(deA[0]).toMatchObject({ anotacao: segredo, de: e1.titulo, ate: e2.titulo });
    // Negativo: B não vê nada, embora a linha de A exista de verdade.
    expect(await sessoesReais(a)).toBe(1);
    expect(await historicoSessoes(b)).toEqual([]);
    expect(await sessaoAberta(b)).toBeNull();
    expect(await faixaDaSessao(b)).toEqual({ aberta: null, ultima: null });
  });

  it("a RLS decide sozinha: sem filtro, cada conta vê só as suas linhas e o papel sem identidade, nenhuma", async () => {
    const a = await novaConta();
    const b = await novaConta();
    await abrirSessao(a, { estudoSlug: e1.slug });
    await abrirSessao(b, { estudoSlug: e2.slug });
    for (const [dono, outro] of [
      [a, b],
      [b, a],
    ] as const) {
      const vistas = await comEstudante(dono, (tx) =>
        tx.select({ dono: sessao.estudanteId }).from(sessao),
      );
      expect(vistas.length).toBeGreaterThanOrEqual(1);
      for (const l of vistas) {
        expect(l.dono).toBe(dono);
        expect(l.dono).not.toBe(outro);
      }
    }
    const semIdentidade = await obterPool().query("select count(*)::int as n from privado.sessao");
    expect(semIdentidade.rows[0]).toEqual({ n: 0 });
  });

  it("A não escreve, altera nem apaga no nome de B (o banco recusa, não um filtro nosso)", async () => {
    const a = await novaConta();
    const b = await novaConta();
    await abrirSessao(b, { estudoSlug: e1.slug });
    const erro = await comEstudante(a, (tx) =>
      tx.insert(sessao).values({ estudanteId: b, estudoInicioId: e2.id }),
    ).catch((e: unknown) => e);
    expect(codigoDe(erro)).toBe("42501");
    const alteradas = await comEstudante(a, (tx) =>
      tx.update(sessao).set({ anotacao: "invadida" }).where(eq(sessao.estudanteId, b)),
    );
    expect(alteradas.rowCount).toBe(0);
    const apagadas = await comEstudante(a, (tx) =>
      tx.delete(sessao).where(eq(sessao.estudanteId, b)),
    );
    expect(apagadas.rowCount).toBe(0);
    // Controle: a Sessão aberta de B continua lá e sem texto.
    expect(await sessoesReais(b)).toBe(1);
    expect((await sessaoAberta(b))?.estudoSlug).toBe(e1.slug);
  });

  it("a exportação traz as Sessões e a Anotação da Sessão da própria conta, e nunca as da vizinha", async () => {
    const a = await novaConta();
    const b = await novaConta();
    const deA = `texto-da-sessao-de-a-${rodada}`;
    const deB = `texto-da-sessao-de-b-${rodada}`;
    await abrirSessao(a, { estudoSlug: e1.slug });
    await encerrarDaTela(a, { anotacao: deA });
    await abrirSessao(b, { estudoSlug: e1.slug });
    await encerrarDaTela(b, { anotacao: deB });
    const arquivoA = JSON.stringify(await exportarDados(a));
    expect(arquivoA).toContain(deA);
    expect(arquivoA).not.toContain(deB);
    expect(JSON.parse(arquivoA).tabelas.sessao).toHaveLength(1);
    // A coluna gerada da busca não é dado da pessoa.
    expect(JSON.parse(arquivoA).tabelas.sessao[0]).not.toHaveProperty("tsv");
  });
});

describe.skipIf(emNeon())("abrir e encerrar a Sessão", () => {
  it("uma segunda abertura com a Sessão aberta não cria linha nova", async () => {
    const id = await novaConta();
    const primeira = await abrirSessao(id, { estudoSlug: e1.slug });
    expect(primeira).toMatchObject({ ok: true, jaAberta: false });
    const segunda = await abrirSessao(id, { estudoSlug: e2.slug });
    // Devolve a que existe (a do primeiro Estudo), sem abrir outra.
    expect(segunda).toMatchObject({ ok: true, jaAberta: true });
    expect(segunda.ok && segunda.sessao.estudoSlug).toBe(e1.slug);
    expect(await sessoesReais(id)).toBe(1);
  });

  it("Estudo que não existe não abre Sessão", async () => {
    const id = await novaConta();
    expect(await abrirSessao(id, { estudoSlug: `nao-existe-${rodada}` })).toEqual({
      ok: false,
      erro: "nao-encontrado",
    });
    expect(await sessoesReais(id)).toBe(0);
  });

  it("sem Estudo, abre na posição mais recente; sem posição, no primeiro Estudo da primeira Trilha", async () => {
    const semPosicao = await novaConta();
    const primeira = await abrirSessao(semPosicao);
    expect(primeira.ok && primeira.sessao.estudoSlug).toBe(e1.slug);

    const comPosicao = await novaConta();
    await registrarPosicao(comPosicao, { trilhaId: trilhaB, estudoId: e3.id });
    const outra = await abrirSessao(comPosicao);
    expect(outra.ok && outra.sessao.estudoSlug).toBe(e3.slug);
  });

  it("201 caracteres são recusados e nada muda; 200 passam inteiros", async () => {
    const id = await novaConta();
    await abrirSessao(id, { estudoSlug: e1.slug });
    const longa = "a".repeat(ANOTACAO_DA_SESSAO_MAX + 1);
    expect(await encerrarDaTela(id, { anotacao: longa })).toEqual({
      ok: false,
      erro: "anotacao-invalida",
    });
    // Continua aberta e sem texto: a recusa veio antes de qualquer escrita.
    expect(await sessaoAberta(id)).not.toBeNull();
    const aindaAberta = await comoDono(async (c) => {
      const r = await c.query(
        "select anotacao from privado.sessao where estudante_id = $1 and check_out_em is null",
        [id],
      );
      return r.rows;
    });
    expect(aindaAberta).toEqual([{ anotacao: null }]);

    const justa = "b".repeat(ANOTACAO_DA_SESSAO_MAX);
    expect(await encerrarDaTela(id, { anotacao: justa })).toMatchObject({ ok: true });
    expect((await historicoSessoes(id))[0]?.anotacao).toBe(justa);
  });

  it("a Anotação é opcional: vazia ou só espaços vira nulo; o NUL de texto é tirado; um valor que não é texto é recusado", async () => {
    const vazia = await novaConta();
    await abrirSessao(vazia, { estudoSlug: e1.slug });
    await encerrarDaTela(vazia, { anotacao: "   " });
    expect((await historicoSessoes(vazia))[0]?.anotacao).toBeNull();

    const comNul = await novaConta();
    await abrirSessao(comNul, { estudoSlug: e1.slug });
    await encerrarDaTela(comNul, { anotacao: "antes\u0000depois" });
    expect((await historicoSessoes(comNul))[0]?.anotacao).toBe("antesdepois");

    const objeto = await novaConta();
    await abrirSessao(objeto, { estudoSlug: e1.slug });
    expect(await encerrarDaTela(objeto, { anotacao: { corpo: "x" } })).toEqual({
      ok: false,
      erro: "anotacao-invalida",
    });
  });

  it("o Estudo final é o da tela; sem ele, a posição mais recente; sem posição, onde a Sessão começou", async () => {
    const daTela = await novaConta();
    await abrirSessao(daTela, { estudoSlug: e1.slug });
    const r1 = await encerrarDaTela(daTela, { estudoSlugAtual: e2.slug, anotacao: null });
    expect(r1).toMatchObject({ ok: true, de: e1.titulo, ate: e2.titulo });

    const daPosicao = await novaConta();
    await abrirSessao(daPosicao, { estudoSlug: e1.slug });
    await registrarPosicao(daPosicao, { trilhaId: trilhaB, estudoId: e3.id });
    const r2 = await encerrarDaTela(daPosicao, { anotacao: null });
    expect(r2).toMatchObject({ ok: true, de: e1.titulo, ate: e3.titulo });
    // Um slug que não existe cai na mesma regra (nunca grava Estudo inventado).
    const slugRuim = await novaConta();
    await abrirSessao(slugRuim, { estudoSlug: e1.slug });
    await registrarPosicao(slugRuim, { trilhaId: trilhaA, estudoId: e2.id });
    const r3 = await encerrarDaTela(slugRuim, { estudoSlugAtual: `nao-existe-${rodada}` });
    expect(r3).toMatchObject({ ok: true, ate: e2.titulo });

    const semPosicao = await novaConta();
    await abrirSessao(semPosicao, { estudoSlug: e2.slug });
    const r4 = await encerrarDaTela(semPosicao, { anotacao: null });
    expect(r4).toMatchObject({ ok: true, de: e2.titulo, ate: e2.titulo });
  });

  it("encerrar sem Sessão aberta não grava nada e diz que não há", async () => {
    const id = await novaConta();
    expect(await encerrarDaTela(id, { anotacao: "x" })).toEqual({
      ok: false,
      erro: "sem-sessao-aberta",
    });
    expect(await sessoesReais(id)).toBe(0);
  });

  it("o fim nunca fica antes do início", async () => {
    const id = await novaConta();
    await abrirSessao(id, { estudoSlug: e1.slug });
    await encerrarDaTela(id, {});
    const [s] = await historicoSessoes(id);
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.checkOutEm.getTime()).toBeGreaterThanOrEqual(s.checkInEm.getTime());
    expect(s.minutos).toBeGreaterThanOrEqual(0);
  });

  it("o histórico traz as 15 últimas encerradas, a mais recente primeiro, sem a aberta", async () => {
    const id = await novaConta();
    await comoDono(async (c) => {
      for (let i = 0; i < 17; i++) {
        await c.query(
          `insert into privado.sessao (estudante_id, check_in_em, check_out_em, estudo_inicio_id, estudo_fim_id, anotacao)
           values ($1, now() - ($2 || ' hours')::interval, now() - ($2 || ' hours')::interval + interval '17 minutes', $3, $3, $4)`,
          [id, String(100 - i), e1.id, `n${i}`],
        );
      }
    });
    await abrirSessao(id, { estudoSlug: e2.slug });
    const historico = await historicoSessoes(id);
    expect(historico).toHaveLength(15);
    // i = 16 é o mais recente (100 - 16 = 84 horas atrás); i = 2 é o décimo quinto.
    expect(historico[0]?.anotacao).toBe("n16");
    expect(historico[14]?.anotacao).toBe("n2");
    expect(historico.every((s) => s.minutos === 17)).toBe(true);
    // Controle: a Sessão aberta existe e não está no histórico.
    expect(await sessaoAberta(id)).not.toBeNull();
    expect(historico.some((s) => s.de === e2.titulo)).toBe(false);
  });
});

describe.skipIf(emNeon())(
  "a fila por Estudante: Sessão, progresso e apagar a conta esperam uns pelos outros",
  () => {
    it("check-out nas duas abas: a segunda espera a primeira, acha a Sessão encerrada e não sobrescreve a Anotação", async () => {
      const id = await novaConta();
      await abrirSessao(id, { estudoSlug: e1.slug });
      const g = comPortao();
      const primeira = encerrarDaTela(
        id,
        { estudoSlugAtual: e2.slug, anotacao: "da primeira aba" },
        { porta: g.porta },
      );
      await g.jaGravou;
      const segunda = encerrarDaTela(id, { anotacao: "da segunda aba" });
      const terminou = observar(segunda);
      await dormir(ESPERA_DA_FILA_MS);
      // Controle: com a primeira ainda segurando a trava, a segunda não pode ter terminado.
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await primeira).toMatchObject({ ok: true });
      expect(await segunda).toEqual({ ok: false, erro: "sem-sessao-aberta" });
      // Uma linha, com o texto da primeira.
      expect(await sessoesReais(id)).toBe(1);
      expect((await historicoSessoes(id))[0]?.anotacao).toBe("da primeira aba");
    });

    it("check-in nas duas abas: a segunda espera e devolve a Sessão que a primeira abriu (uma linha só)", async () => {
      const id = await novaConta();
      const g = comPortao();
      const primeira = abrirSessao(id, { estudoSlug: e1.slug }, { porta: g.porta });
      await g.jaGravou;
      const segunda = abrirSessao(id, { estudoSlug: e2.slug });
      const terminou = observar(segunda);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await primeira).toMatchObject({ ok: true, jaAberta: false });
      const resposta = await segunda;
      expect(resposta).toMatchObject({ ok: true, jaAberta: true });
      expect(resposta.ok && resposta.sessao.estudoSlug).toBe(e1.slug);
      expect(await sessoesReais(id)).toBe(1);
    });

    it("check-in de uma aba desatualizada espera o check-out e abre uma Sessão nova depois dele", async () => {
      const id = await novaConta();
      await abrirSessao(id, { estudoSlug: e1.slug });
      const g = comPortao();
      const fechando = encerrarDaTela(id, { anotacao: "da primeira Sessão" }, { porta: g.porta });
      await g.jaGravou;
      // A outra aba ainda mostra "Nenhuma Sessão aberta" e pede o check-in.
      const abrir = abrirSessao(id, { estudoSlug: e2.slug });
      const terminou = observar(abrir);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await fechando).toMatchObject({ ok: true });
      expect(await abrir).toMatchObject({ ok: true, jaAberta: false });
      expect(await sessoesReais(id)).toBe(2);
      expect((await historicoSessoes(id))[0]?.anotacao).toBe("da primeira Sessão");
      expect((await sessaoAberta(id))?.estudoSlug).toBe(e2.slug);
    });

    it("o check-out leva o id da Sessão exibida: a aba que mostra a Sessão 1 não encerra a Sessão 2 aberta depois", async () => {
      const id = await novaConta();
      const s1 = await abrirSessao(id, { estudoSlug: e1.slug });
      const idS1 = s1.ok ? s1.sessao.id : "";
      expect(idS1).not.toBe("");
      // A aba A abre a folha de check-out da Sessão 1 e demora a enviar. A aba B encerra a Sessão 1 e,
      // com a trava na mão, abre a Sessão 2: é neste instante que a aba A envia o texto dela.
      expect(await encerrarSessao(id, { sessaoId: idS1, anotacao: "da aba B" })).toMatchObject({
        ok: true,
      });
      const g = comPortao();
      const abrindoS2 = abrirSessao(id, { estudoSlug: e2.slug }, { porta: g.porta });
      await g.jaGravou;
      const envioDaA = encerrarSessao(id, {
        sessaoId: idS1,
        anotacao: "da aba A, para a Sessão 1",
      });
      const terminou = observar(envioDaA);
      await dormir(ESPERA_DA_FILA_MS);
      // Controle: o envio da A está na fila atrás da abertura da Sessão 2.
      expect(terminou()).toBe(false);
      g.soltar();
      const s2 = await abrindoS2;
      const idS2 = s2.ok ? s2.sessao.id : "";
      expect(idS2).not.toBe(idS1);
      // A resposta é a mesma de "Sessão já encerrada em outra aba", e nada foi gravado.
      expect(await envioDaA).toEqual({ ok: false, erro: "sem-sessao-aberta" });
      const linhas = await comoDono(async (c) => {
        const r = await c.query(
          "select id, check_out_em is null as aberta, anotacao from privado.sessao where estudante_id = $1 order by check_in_em",
          [id],
        );
        return r.rows as { id: string; aberta: boolean; anotacao: string | null }[];
      });
      expect(linhas).toEqual([
        { id: idS1, aberta: false, anotacao: "da aba B" },
        { id: idS2, aberta: true, anotacao: null },
      ]);
      // A Anotação da aba A não está em lugar nenhum.
      expect(JSON.stringify(linhas)).not.toContain("da aba A");
    });

    it("o id da Sessão de outra conta, ou que não é um uuid, não encerra nada", async () => {
      const a = await novaConta();
      const b = await novaConta();
      await abrirSessao(a, { estudoSlug: e1.slug });
      const sb = await abrirSessao(b, { estudoSlug: e1.slug });
      const idDeB = sb.ok ? sb.sessao.id : "";
      // A pede o check-out com o id da Sessão de B: a RLS e o filtro por Estudante recusam.
      expect(await encerrarSessao(a, { sessaoId: idDeB, anotacao: "invasão" })).toEqual({
        ok: false,
        erro: "sem-sessao-aberta",
      });
      expect(await encerrarSessao(a, { sessaoId: "nao-e-uuid", anotacao: "x" })).toEqual({
        ok: false,
        erro: "sem-sessao-aberta",
      });
      expect(await encerrarSessao(a, { anotacao: "sem id" })).toEqual({
        ok: false,
        erro: "sem-sessao-aberta",
      });
      // As duas Sessões seguem abertas e sem texto.
      expect((await sessaoAberta(a))?.id).toBeDefined();
      expect((await sessaoAberta(b))?.id).toBe(idDeB);
      expect(
        await comoDono(async (c) => {
          const r = await c.query(
            "select count(*)::int as n from privado.sessao where anotacao is not null and estudante_id = any($1)",
            [[a, b]],
          );
          return r.rows[0]?.n as number;
        }),
      ).toBe(0);
    });

    it("check-out junto de apagar a conta: apagar espera o check-out e não sobra linha da conta", async () => {
      const id = await novaConta();
      await abrirSessao(id, { estudoSlug: e1.slug });
      const g = comPortao();
      const fechar = encerrarDaTela(id, { anotacao: "segredo" }, { porta: g.porta });
      await g.jaGravou;
      const apagar = removerConta(id);
      const terminou = observar(apagar);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await fechar).toMatchObject({ ok: true });
      expect(await apagar).toEqual({ ok: true });
      expect(await sessoesReais(id)).toBe(0);
    });

    it("apagar a conta junto de um check-out: o check-out espera e acha a conta sem Sessão, sem erro e sem linha órfã", async () => {
      const id = await novaConta();
      await abrirSessao(id, { estudoSlug: e1.slug });
      const base = obterDb();
      let soltar = () => {};
      const portao = new Promise<void>((r) => {
        soltar = r;
      });
      let gravou = () => {};
      const jaGravou = new Promise<void>((r) => {
        gravou = r;
      });
      // O `db` de `removerConta` com a transação segura até soltar, como a porta lenta das outras.
      const lento = {
        transaction: (fn: Parameters<typeof base.transaction>[0], cfg?: never) =>
          base.transaction(async (tx) => {
            const r = await fn(tx);
            gravou();
            await portao;
            return r;
          }, cfg),
      } as unknown as typeof base;
      const apagar = removerConta(id, { db: lento });
      await jaGravou;
      const fechar = encerrarDaTela(id, { anotacao: "tarde demais" });
      const terminou = observar(fechar);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      soltar();
      expect(await apagar).toEqual({ ok: true });
      expect(await fechar).toEqual({ ok: false, erro: "sem-sessao-aberta" });
      expect(await sessoesReais(id)).toBe(0);
    });

    it("check-in depois de a conta ser apagada: a chave estrangeira recusa e não fica linha órfã", async () => {
      const id = await novaConta();
      await removerConta(id);
      const erro = await abrirSessao(id, { estudoSlug: e1.slug }).catch((e: unknown) => e);
      expect(codigoDe(erro)).toBe("23503");
      expect(await sessoesReais(id)).toBe(0);
    });

    it("check-out junto de uma nova volta: um espera o outro, nos dois sentidos", async () => {
      // Sentido 1: o check-out segura a trava; a nova volta espera.
      const a = await novaConta();
      await abrirSessao(a, { estudoSlug: e1.slug });
      const g1 = comPortao();
      const fechar = encerrarDaTela(a, { anotacao: "x" }, { porta: g1.porta });
      await g1.jaGravou;
      const volta1 = iniciarNovaVolta(a);
      const terminou1 = observar(volta1);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou1()).toBe(false);
      g1.soltar();
      expect(await fechar).toMatchObject({ ok: true });
      expect(await volta1).toEqual({ ok: false, erro: "incompleta" });

      // Sentido 2: a nova volta segura a trava; o check-out espera.
      const b = await novaConta();
      await abrirSessao(b, { estudoSlug: e1.slug });
      const g2 = comPortao();
      const volta2 = iniciarNovaVolta(b, { porta: g2.porta });
      await g2.jaGravou;
      const fechar2 = encerrarDaTela(b, { anotacao: "y" });
      const terminou2 = observar(fechar2);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou2()).toBe(false);
      g2.soltar();
      await volta2;
      expect(await fechar2).toMatchObject({ ok: true });
    });

    it("exportar espera o check-out e traz a Sessão já encerrada, inteira", async () => {
      const id = await novaConta();
      await abrirSessao(id, { estudoSlug: e1.slug });
      const g = comPortao();
      const fechar = encerrarDaTela(
        id,
        { anotacao: `na-exportacao-${rodada}` },
        { porta: g.porta },
      );
      await g.jaGravou;
      const exportar = exportarDados(id);
      const terminou = observar(exportar);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      await fechar;
      const arquivo = await exportar;
      expect(arquivo.tabelas.sessao).toHaveLength(1);
      expect(JSON.stringify(arquivo.tabelas.sessao)).toContain(`na-exportacao-${rodada}`);
    });
  },
);
