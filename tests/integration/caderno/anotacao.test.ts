import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterDb, obterPool } from "@/db/cliente";
import { comEstudante } from "@/db/com-estudante";
import { usuario } from "@/db/schema/fundacao";
import { urlDoPapel } from "@/db/url";
import {
  type AnotacaoDoEstudo,
  lerAnotacaoDoEstudo,
  type ResultadoDeSalvar,
  salvarAnotacaoDoEstudo,
} from "@/modules/caderno/anotacao-nucleo";
import { ANOTACAO_MAX } from "@/modules/caderno/limite";
import { exportarDados } from "@/modules/privacidade/exportar";
import { removerConta } from "@/modules/privacidade/remover-conta";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Anotação (ANOT-01, ANOT-02): dado privado do Estudante, salvo com a base (id e versão) do que a tela
// mostrava. Este arquivo cria e usa um banco descartável SÓ dele (o compartilhado é contado por outros
// testes e linhas criadas aqui o fariam variar). O bloco do catálogo é só leitura e roda também no Neon; o
// resto cria linhas e não roda lá.

const emNeon = () => inject("alvoBanco") === "neon";

const rodada = randomUUID();
const trilha = `trilha-anot-${rodada.slice(0, 8)}`;
const HASH = createHash("sha256").update(rodada).digest("hex");
const estudos = [
  { id: randomUUID(), slug: `anot-1-${rodada}`, titulo: `Estudo 1 ${rodada.slice(0, 6)}` },
  { id: randomUUID(), slug: `anot-2-${rodada}`, titulo: `Estudo 2 ${rodada.slice(0, 6)}` },
] as const;
const [e1, e2] = estudos;
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

const linhasReais = (estudante: string, estudoId?: string) =>
  comoDono(async (c) => {
    const r = await c.query(
      `select count(*)::int as n from privado.anotacao where estudante_id = $1 and ($2::uuid is null or estudo_id = $2)`,
      [estudante, estudoId ?? null],
    );
    return r.rows[0]?.n as number;
  });

const corpoReal = (estudante: string, estudoId: string) =>
  comoDono(async (c) => {
    const r = await c.query(
      `select corpo from privado.anotacao where estudante_id = $1 and estudo_id = $2`,
      [estudante, estudoId],
    );
    return (r.rows[0]?.corpo as string | undefined) ?? null;
  });

async function novaConta(): Promise<string> {
  const id = randomUUID();
  await obterDb()
    .insert(usuario)
    .values({ id, email: `an-${id}@example.test` });
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

const ESPERA_DA_FILA_MS = 400;

// Salva como a tela faz: com a base do que ela mostrava.
const salvar = (
  id: string,
  estudoId: string,
  corpo: string,
  base: AnotacaoDoEstudo | null,
  extra?: Parameters<typeof salvarAnotacaoDoEstudo>[2],
) =>
  salvarAnotacaoDoEstudo(
    id,
    { estudoId, corpo, versaoBase: base?.versao ?? 0, baseId: base?.id ?? null },
    extra,
  );

function aceito(r: ResultadoDeSalvar): AnotacaoDoEstudo {
  if (!r.ok || !r.anotacao) throw new Error("esperava uma Anotação gravada");
  return r.anotacao;
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
      "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, $2, 1, 'x')",
      [trilha, `Trilha ${rodada}`],
    );
    for (const [i, e] of estudos.entries()) {
      await c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, $4, $5, 'devocional', 'x', $6)`,
        [e.id, e.slug, trilha, i + 1, e.titulo, HASH],
      );
    }
  });
});

afterAll(async () => {
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe("catálogo: a Anotação aponta para o Estudo sem apagá-lo calada (só leitura, vale também no Neon)", () => {
  it("a chave estrangeira de estudo_id é RESTRICT e a de estudante_id é cascata", async () => {
    const r = await obterPool().query<{ coluna: string; acao: string; alvo: string }>(`
      select a.attname as coluna, k.confdeltype as acao, k.confrelid::regclass::text as alvo
      from pg_constraint k
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
      where k.conrelid = 'privado.anotacao'::regclass and k.contype = 'f'
      order by 1`);
    expect(r.rows).toEqual([
      { coluna: "estudante_id", acao: "c", alvo: 'auth."user"' },
      { coluna: "estudo_id", acao: "r", alvo: "conteudo.estudo" },
    ]);
  });

  it("não há restrição de verificação na tabela (o banco repetiria o texto numa violação)", async () => {
    const r = await obterPool().query<{ n: number }>(
      `select count(*)::int as n from pg_constraint where conrelid = 'privado.anotacao'::regclass and contype = 'c'`,
    );
    expect(r.rows[0]?.n).toBe(0);
  });
});

describe.skipIf(emNeon())("salvar e ler a Anotação", () => {
  it("A salva e lê o próprio texto; reabrir devolve o mesmo", async () => {
    const a = await novaConta();
    expect(await lerAnotacaoDoEstudo(a, e1.id)).toBeNull();
    const primeira = aceito(await salvar(a, e1.id, "primeira versão", null));
    expect(primeira).toMatchObject({ corpo: "primeira versão", versao: 1 });
    expect(await lerAnotacaoDoEstudo(a, e1.id)).toEqual(primeira);
    expect(await linhasReais(a)).toBe(1);
  });

  it("editar de novo incrementa a versão e guarda o texto novo", async () => {
    const a = await novaConta();
    const v1 = aceito(await salvar(a, e1.id, "um", null));
    const v2 = aceito(await salvar(a, e1.id, "dois", v1));
    expect(v2).toMatchObject({ corpo: "dois", versao: 2, id: v1.id });
    expect(new Date(v2.atualizadoEm).getTime()).toBeGreaterThanOrEqual(
      new Date(v1.atualizadoEm).getTime(),
    );
    expect(await linhasReais(a)).toBe(1);
  });

  it("B não lê a Anotação de A e a gravação de B não toca a de A (mesmo Estudo)", async () => {
    const a = await novaConta();
    const b = await novaConta();
    aceito(await salvar(a, e1.id, `segredo-de-a-${rodada}`, null));
    expect(await lerAnotacaoDoEstudo(b, e1.id)).toBeNull();
    const deB = aceito(await salvar(b, e1.id, "de b", null));
    expect(deB.versao).toBe(1);
    expect((await lerAnotacaoDoEstudo(a, e1.id))?.corpo).toBe(`segredo-de-a-${rodada}`);
    // Controle: cada uma tem a sua linha.
    expect(await linhasReais(a)).toBe(1);
    expect(await linhasReais(b)).toBe(1);
  });

  it("a base é o id E a versão: versão errada e id errado devolvem o conflito, sem gravar", async () => {
    const a = await novaConta();
    const v1 = aceito(await salvar(a, e1.id, "original", null));
    // Versão base errada (a tela mostrava uma versão antiga).
    const antiga = await salvar(a, e1.id, "da aba velha", { ...v1, versao: 0 });
    expect(antiga).toMatchObject({
      ok: false,
      erro: "conflito",
      conta: { id: v1.id, corpo: "original", versao: 1 },
    });
    // Id errado com a versão certa (outra Anotação que ocupou o lugar).
    const outra = await salvar(a, e1.id, "da outra", { ...v1, id: randomUUID() });
    expect(outra).toMatchObject({ ok: false, erro: "conflito", conta: { id: v1.id } });
    // Nada foi gravado.
    expect(await corpoReal(a, e1.id)).toBe("original");
    expect((await lerAnotacaoDoEstudo(a, e1.id))?.versao).toBe(1);
  });

  it("sem base, com uma Anotação já existente: conflito, nunca sobrescreve", async () => {
    const a = await novaConta();
    aceito(await salvar(a, e1.id, "já existia", null));
    const r = await salvar(a, e1.id, "de quem não via nada", null);
    expect(r).toMatchObject({ ok: false, erro: "conflito", conta: { corpo: "já existia" } });
    expect(await corpoReal(a, e1.id)).toBe("já existia");
  });

  it("apagada em outro aparelho e recriada do zero (versão 1 de novo): a aba velha recebe conflito, não sobrescreve", async () => {
    const a = await novaConta();
    const antiga = aceito(await salvar(a, e1.id, "a que a aba velha mostra", null));
    // Outro aparelho apaga e escreve do zero: a versão volta a 1, com outro id.
    await salvar(a, e1.id, "", antiga);
    const nova = aceito(await salvar(a, e1.id, "a nova, do outro aparelho", null));
    expect(nova.versao).toBe(1);
    expect(nova.id).not.toBe(antiga.id);
    // A aba velha ainda acha que a Anotação é a `antiga` (mesma versão 1).
    const r = await salvar(a, e1.id, "texto da aba velha", antiga);
    expect(r).toMatchObject({ ok: false, erro: "conflito", conta: { id: nova.id, versao: 1 } });
    expect(await corpoReal(a, e1.id)).toBe("a nova, do outro aparelho");
  });

  it("Anotação apagada em outro aparelho: salvar texto novo sobre a base velha devolve o conflito (conta vazia) e não a ressuscita", async () => {
    const a = await novaConta();
    const v1 = aceito(await salvar(a, e1.id, "vai sumir", null));
    await salvar(a, e1.id, "", v1);
    const r = await salvar(a, e1.id, "texto novo da aba velha", v1);
    expect(r).toEqual({
      ok: false,
      erro: "conflito",
      conta: { id: null, corpo: "", versao: 0, atualizadoEm: null },
    });
    expect(await linhasReais(a)).toBe(0);
  });

  it("corpo vazio, ou só espaços, apaga a linha: é assim que o Estudante apaga a própria Anotação", async () => {
    const a = await novaConta();
    const v1 = aceito(await salvar(a, e1.id, "para apagar", null));
    expect(await salvar(a, e1.id, "   \n ", v1)).toEqual({ ok: true, anotacao: null });
    expect(await linhasReais(a)).toBe(0);
    expect(await lerAnotacaoDoEstudo(a, e1.id)).toBeNull();
    // Apagar o que já não existe, com a base de quem nunca viu nada, é nada a fazer.
    expect(await salvar(a, e1.id, "", null)).toEqual({ ok: true, anotacao: null });
  });

  it("20 000 caracteres passam inteiros; 20 001 são recusados e nada muda", async () => {
    const a = await novaConta();
    const cheio = "a".repeat(ANOTACAO_MAX);
    const v1 = aceito(await salvar(a, e1.id, cheio, null));
    expect(v1.corpo).toHaveLength(ANOTACAO_MAX);
    const r = await salvar(a, e1.id, "b".repeat(ANOTACAO_MAX + 1), v1);
    expect(r).toEqual({ ok: false, erro: "limite" });
    expect(await corpoReal(a, e1.id)).toBe(cheio);
    expect((await lerAnotacaoDoEstudo(a, e1.id))?.versao).toBe(1);
    // O limite vale também para a primeira gravação.
    const b = await novaConta();
    expect(await salvar(b, e1.id, "c".repeat(ANOTACAO_MAX + 1), null)).toEqual({
      ok: false,
      erro: "limite",
    });
    expect(await linhasReais(b)).toBe(0);
  });

  it("o NUL de texto é tirado antes de gravar (o Postgres não o guarda)", async () => {
    const a = await novaConta();
    const v1 = aceito(await salvar(a, e1.id, "com\u0000nulo", null));
    expect(v1.corpo).toBe("comnulo");
  });

  it("reenviar o que o servidor já tem (a resposta se perdeu) não vira conflito", async () => {
    const a = await novaConta();
    const v1 = aceito(await salvar(a, e1.id, "base", null));
    const v2 = aceito(await salvar(a, e1.id, "texto que gravou", v1));
    // A aba não recebeu a resposta e reenvia com a base velha.
    const reenvio = await salvar(a, e1.id, "texto que gravou", v1);
    expect(reenvio).toEqual({ ok: true, anotacao: v2 });
    expect((await lerAnotacaoDoEstudo(a, e1.id))?.versao).toBe(2);
  });

  it("Estudo que não existe: nada é gravado e a resposta diz que não achou", async () => {
    const a = await novaConta();
    expect(await salvar(a, randomUUID(), "texto", null)).toEqual({
      ok: false,
      erro: "nao-encontrado",
    });
    expect(await linhasReais(a)).toBe(0);
  });

  it("uma Anotação por Estudo: dois Estudos, duas linhas independentes", async () => {
    const a = await novaConta();
    const um = aceito(await salvar(a, e1.id, "do um", null));
    const dois = aceito(await salvar(a, e2.id, "do dois", null));
    expect(um.id).not.toBe(dois.id);
    expect(await linhasReais(a)).toBe(2);
  });

  it("um Estudo com Anotação não sai do conteúdo: o banco recusa, não apaga o texto de quem escreveu", async () => {
    const a = await novaConta();
    const solto = randomUUID();
    await comoCarga((c) =>
      c.query(
        `insert into conteudo.estudo (id, slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
         values ($1, $2, $3, 9, 'Solto', 'devocional', 'x', $4)`,
        [solto, `solto-${solto}`, trilha, HASH],
      ),
    );
    aceito(await salvar(a, solto, "texto que não pode ir embora", null));
    const erro = await comoCarga((c) =>
      c.query("delete from conteudo.estudo where id = $1", [solto]),
    ).catch((e: unknown) => e);
    expect(erro).toMatchObject({ code: "23503", constraint: "anotacao_estudo_id_fkey" });
    expect(await corpoReal(a, solto)).toBe("texto que não pode ir embora");
  });
});

describe.skipIf(emNeon())(
  "a fila por Estudante: salvar, exportar e apagar a conta esperam uns pelos outros",
  () => {
    it("duas abas salvando juntas: a segunda espera a primeira, recebe o conflito e não sobrescreve", async () => {
      const a = await novaConta();
      const v1 = aceito(await salvar(a, e1.id, "base", null));
      const g = comPortao();
      const primeira = salvar(a, e1.id, "da primeira aba", v1, { porta: g.porta });
      await g.jaGravou;
      const segunda = salvar(a, e1.id, "da segunda aba", v1);
      const terminou = observar(segunda);
      await dormir(ESPERA_DA_FILA_MS);
      // Controle: com a primeira ainda segurando a trava, a segunda não pode ter terminado.
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await primeira).toMatchObject({ ok: true });
      expect(await segunda).toMatchObject({
        ok: false,
        erro: "conflito",
        conta: { corpo: "da primeira aba", versao: 2 },
      });
      expect(await corpoReal(a, e1.id)).toBe("da primeira aba");
      expect(await linhasReais(a)).toBe(1);
    });

    it("duas abas criando a primeira Anotação juntas: uma linha só, e a segunda recebe o conflito", async () => {
      const a = await novaConta();
      const g = comPortao();
      const primeira = salvar(a, e1.id, "da primeira aba", null, { porta: g.porta });
      await g.jaGravou;
      const segunda = salvar(a, e1.id, "da segunda aba", null);
      const terminou = observar(segunda);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await primeira).toMatchObject({ ok: true });
      expect(await segunda).toMatchObject({ ok: false, erro: "conflito" });
      expect(await linhasReais(a)).toBe(1);
      expect(await corpoReal(a, e1.id)).toBe("da primeira aba");
    });

    it("salvar junto de apagar a conta: apagar espera o salvar e não sobra linha da conta", async () => {
      const a = await novaConta();
      const g = comPortao();
      const gravar = salvar(a, e1.id, "segredo", null, { porta: g.porta });
      await g.jaGravou;
      const apagar = removerConta(a);
      const terminou = observar(apagar);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      expect(await gravar).toMatchObject({ ok: true });
      expect(await apagar).toEqual({ ok: true });
      expect(await linhasReais(a)).toBe(0);
    });

    it("apagar a conta junto de um salvar: o salvar espera e a chave estrangeira o recusa, sem linha órfã", async () => {
      const a = await novaConta();
      const base = obterDb();
      let soltar = () => {};
      const portao = new Promise<void>((r) => {
        soltar = r;
      });
      let gravou = () => {};
      const jaGravou = new Promise<void>((r) => {
        gravou = r;
      });
      const lento = {
        transaction: (fn: Parameters<typeof base.transaction>[0], cfg?: never) =>
          base.transaction(async (tx) => {
            const r = await fn(tx);
            gravou();
            await portao;
            return r;
          }, cfg),
      } as unknown as typeof base;
      const apagar = removerConta(a, { db: lento });
      await jaGravou;
      const tarde = salvar(a, e1.id, "tarde demais", null).catch((e: unknown) => e);
      const terminou = observar(tarde);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      soltar();
      expect(await apagar).toEqual({ ok: true });
      const erro = await tarde;
      // A conta já não existe: a chave estrangeira de estudante_id recusa (a ação trata como conta apagada).
      expect((erro as { code?: string }).code).toBe("23503");
      expect((erro as { constraint?: string }).constraint).toContain("estudante_id");
      expect(await linhasReais(a)).toBe(0);
    });

    it("salvar espera a exportação: o arquivo traz a Anotação de antes, inteira, e o texto novo vem depois", async () => {
      const a = await novaConta();
      const v1 = aceito(await salvar(a, e1.id, `antes-${rodada}`, null));
      const g = comPortao();
      const exportar = exportarDados(a, { porta: g.porta });
      await g.jaGravou;
      const gravar = salvar(a, e1.id, `depois-${rodada}`, v1);
      const terminou = observar(gravar);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      const arquivo = JSON.stringify((await exportar).tabelas.anotacao);
      expect(arquivo).toContain(`antes-${rodada}`);
      expect(arquivo).not.toContain(`depois-${rodada}`);
      expect(await gravar).toMatchObject({ ok: true });
      expect(await corpoReal(a, e1.id)).toBe(`depois-${rodada}`);
    });

    it("exportar espera o salvar: o arquivo traz o texto que acabou de ser gravado, inteiro", async () => {
      const a = await novaConta();
      const g = comPortao();
      const gravar = salvar(a, e1.id, `na-exportacao-${rodada}`, null, { porta: g.porta });
      await g.jaGravou;
      const exportar = exportarDados(a);
      const terminou = observar(exportar);
      await dormir(ESPERA_DA_FILA_MS);
      expect(terminou()).toBe(false);
      g.soltar();
      await gravar;
      const arquivo = await exportar;
      expect(JSON.stringify(arquivo.tabelas.anotacao)).toContain(`na-exportacao-${rodada}`);
    });
  },
);
