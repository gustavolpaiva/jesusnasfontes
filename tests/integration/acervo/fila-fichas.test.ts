import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { filaDeFichas, lerFichaParaAdmin } from "@/modules/acervo/consultas-admin";
import { lerFicha } from "@/modules/acervo/consultas-ficha";
import { listarFontesPorNivel } from "@/modules/acervo/consultas-lista";
import {
  ConteudoMudou,
  EdicaoNaoConfirmada,
  FaltamPaginas,
  SegundoFatorVencido,
} from "@/modules/acervo/erros";
import { interpretarFichaYaml } from "@/modules/acervo/schemas";
import { conferirItemUmaVez, verificarFichaUmaVez } from "@/modules/acervo/verificacao";
import { carregarRascunhos } from "../../../scripts/acervo/carregar-rascunhos";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { type CasoDeSessao, criarSessaoDeTeste } from "../../support/sessao-admin-banco";

// A fila e o detalhe de fichas do painel do Admin (ACER-07, plano 02-18) e as duas portas de escrita que o painel usa
// (`conferirItemUmaVez`, `verificarFichaUmaVez`) sobre as funções do banco do plano 05. Fichas FICTÍCIAS, uma em cada
// estado; cria dado, então usa um banco descartável SÓ deste arquivo e não roda no Neon.

vi.mock("server-only", () => ({}));

const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let dono: pg.Client;
let admin: string;

const SLUGS = {
  rascunho: "fila-rascunho",
  emConferencia: "fila-em-conferencia",
  pronta: "fila-pronta",
  verificada: "fila-verificada",
  alterada: "fila-alterada",
  confirmar: "fila-edicao-a-confirmar",
};

function ficha(slug: string, titulo: string, extra: Record<string, unknown> = {}) {
  return interpretarFichaYaml(
    JSON.stringify({
      slug,
      titulo,
      autor: "Autora de Teste",
      ano: 2001,
      editora: "Editora de Teste",
      edicao_consultada: "Primeira edição de teste, 2001",
      estado: "rascunho",
      origem_do_rascunho: "memoria-do-modelo",
      idioma_trechos: "en",
      tese_pt: "Tese inventada, só para o teste.",
      serve_a: [],
      itens: [
        { tipo: "argumento", texto_pt: "Argumento um.", pagina: "10", confianca: "alta" },
        { tipo: "argumento", texto_pt: "Argumento dois.", pagina: "12-14", confianca: "media" },
        {
          tipo: "trecho",
          texto_pt: "Tradução do trecho.",
          trecho_original: "An invented sentence.",
          pagina: "xi-xii",
          confianca: "alta",
        },
      ],
      ...extra,
    }),
    `${slug}.yaml`,
  );
}

const ids = async (slug: string): Promise<{ id: string; hash: string }[]> =>
  (
    await dono.query<{ id: string; conteudo_hash: string }>(
      `select i.id, i.conteudo_hash from acervo.ficha_item i join acervo.fonte f on f.id = i.ficha_id
        where f.slug = $1 order by i.tipo, i.ordem`,
      [slug],
    )
  ).rows.map((r) => ({ id: r.id, hash: r.conteudo_hash }));

const dadosDaFicha = async (slug: string) =>
  (
    await dono.query<{ id: string; hash: string }>(
      `select f.fonte_id as id, f.conteudo_hash as hash from acervo.ficha f join acervo.fonte o on o.id = f.fonte_id where o.slug = $1`,
      [slug],
    )
  ).rows[0] as { id: string; hash: string };

async function conferirTodos(slug: string, quantos = Number.POSITIVE_INFINITY) {
  const itens = await ids(slug);
  for (const i of itens.slice(0, quantos)) await conferirItemUmaVez(admin, i.id, i.hash);
}

async function verificar(slug: string) {
  const f = await dadosDaFicha(slug);
  return verificarFichaUmaVez(admin, f.id, f.hash);
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.env.DATABASE_URL_OWNER });
  await dono.connect();
  await carregarRascunhos(
    [
      ficha(SLUGS.rascunho, "Ficha em rascunho"),
      ficha(SLUGS.emConferencia, "Ficha em conferência"),
      ficha(SLUGS.pronta, "Ficha pronta"),
      ficha(SLUGS.verificada, "Ficha verificada"),
      ficha(SLUGS.alterada, "Ficha alterada"),
      ficha(SLUGS.confirmar, "Ficha com edição a confirmar", {
        edicao_consultada: "A confirmar: edição de teste",
      }),
    ],
    { cliente: carga },
  );
  admin = (await criarSessaoDeTeste(dono, "admin-com-segundo-fator")).sessaoId;
  // Um estado em cada ficha, SEMPRE pelas portas e funções reais.
  await conferirTodos(SLUGS.emConferencia, 1);
  await conferirTodos(SLUGS.pronta);
  await conferirTodos(SLUGS.verificada);
  await verificar(SLUGS.verificada);
  await conferirTodos(SLUGS.alterada);
  await verificar(SLUGS.alterada);
  await dono.query(
    "update acervo.ficha set tese_pt = tese_pt || ' Mudou depois de verificada.' where fonte_id = (select id from acervo.fonte where slug = $1)",
    [SLUGS.alterada],
  );
}, 180_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("fila de fichas", () => {
  it("cinco estados, na ordem do contrato, com a contagem de páginas conferidas", async () => {
    const fila = await filaDeFichas(admin);
    const resumo = fila.map((f) => [f.slug, f.estado, f.conferidos, f.total]);
    // Prontas, em conferência, rascunhos, alteradas, verificadas; empate pelo título.
    expect(resumo.filter((r) => r[0] !== SLUGS.confirmar)).toEqual([
      [SLUGS.pronta, "pronta", 3, 3],
      [SLUGS.emConferencia, "em-conferencia", 1, 3],
      [SLUGS.rascunho, "rascunho", 0, 3],
      [SLUGS.alterada, "alterada", 3, 3],
      [SLUGS.verificada, "verificada", 3, 3],
    ]);
    // A ficha com edição "A confirmar" nunca foi conferida: rascunho, e fica depois da outra por título.
    expect(fila.find((f) => f.slug === SLUGS.confirmar)?.estado).toBe("rascunho");
    // A data só vai para quem está verificada com o hash atual.
    expect(fila.find((f) => f.slug === SLUGS.verificada)?.verificadaEm).toBeInstanceOf(Date);
    expect(fila.find((f) => f.slug === SLUGS.alterada)?.verificadaEm).toBeNull();
  });

  it("'Alterada' some da vista do Estudante, e só a verificada aparece", async () => {
    expect(await lerFicha(SLUGS.alterada)).toBeNull();
    expect(await lerFicha(SLUGS.pronta)).toBeNull();
    expect(await lerFicha(SLUGS.rascunho)).toBeNull();
    expect((await lerFicha(SLUGS.verificada))?.slug).toBe(SLUGS.verificada);
    const lista = await listarFontesPorNivel(null);
    const slugs = lista.grupos.flatMap((g) => g.fontes.map((f) => f.slug));
    expect(slugs).toContain(SLUGS.verificada);
    for (const fora of [SLUGS.alterada, SLUGS.pronta, SLUGS.emConferencia, SLUGS.rascunho])
      expect(slugs).not.toContain(fora);
  });

  it("controle negativo: sessão sem Admin com segundo fator não vê rascunho nem alterada na fila", async () => {
    const casos: CasoDeSessao[] = [
      "estudante",
      "admin-sem-segundo-fator",
      "geracao-antiga",
      "sessao-vencida",
    ];
    for (const caso of casos) {
      const { sessaoId } = await criarSessaoDeTeste(dono, caso);
      const fila = await filaDeFichas(sessaoId);
      expect(
        fila.map((f) => f.slug),
        caso,
      ).toEqual([SLUGS.verificada]);
    }
    // Controle positivo: o Admin com segundo fator vê as seis.
    expect(await filaDeFichas(admin)).toHaveLength(6);
  });
});

describe.skipIf(emNeon())("detalhe da ficha para o Admin", () => {
  it("a ficha inteira, com a conferência de cada item e a edição confirmada", async () => {
    const f = await lerFichaParaAdmin(admin, SLUGS.emConferencia);
    expect(f).toMatchObject({
      slug: SLUGS.emConferencia,
      estado: "em-conferencia",
      conferidos: 1,
      total: 3,
      edicaoConfirmada: true,
    });
    expect(f?.argumentos.map((i) => i.conferidaEm !== null)).toEqual([true, false]);
    expect(f?.trechos.map((i) => i.conferidaEm !== null)).toEqual([false]);
    expect(f?.argumentos[0]?.id).toBe(`${SLUGS.emConferencia}/argumento-1`);
    // Sem coluna de pessoa (D-05): nada de quem conferiu ou verificou.
    const chaves = JSON.stringify(
      Object.keys(f as object).concat(Object.keys(f?.argumentos[0] ?? {})),
    );
    expect(chaves).not.toMatch(/por|admin|email|usuario/i);
  });

  it("edição 'A confirmar' vem marcada, e ficha inexistente ou de texto integral é null (404)", async () => {
    expect((await lerFichaParaAdmin(admin, SLUGS.confirmar))?.edicaoConfirmada).toBe(false);
    expect(await lerFichaParaAdmin(admin, "nao-existe")).toBeNull();
  });

  it("item mudado volta a 'A conferir' e a ficha verificada vira 'alterada'", async () => {
    const f = await lerFichaParaAdmin(admin, SLUGS.alterada);
    expect(f?.estado).toBe("alterada");
    expect(f?.conferidos).toBe(3);
    expect(f?.verificadaEm).toBeNull();
  });

  it("sessão sem segundo fator não lê rascunho", async () => {
    const { sessaoId } = await criarSessaoDeTeste(dono, "estudante");
    expect(await lerFichaParaAdmin(sessaoId, SLUGS.rascunho)).toBeNull();
    expect(await lerFichaParaAdmin(admin, SLUGS.rascunho)).not.toBeNull();
  });
});

describe.skipIf(emNeon())("portas de escrita do painel", () => {
  it("recusa sem Admin com segundo fator (42501) em cada caso, e o controle positivo grava", async () => {
    const alvo = (await ids(SLUGS.rascunho))[0] as { id: string; hash: string };
    for (const caso of [
      "estudante",
      "admin-sem-segundo-fator",
      "geracao-antiga",
      "sessao-vencida",
    ] as CasoDeSessao[]) {
      const { sessaoId } = await criarSessaoDeTeste(dono, caso);
      await expect(conferirItemUmaVez(sessaoId, alvo.id, alvo.hash), caso).rejects.toBeInstanceOf(
        SegundoFatorVencido,
      );
      const f = await dadosDaFicha(SLUGS.rascunho);
      await expect(verificarFichaUmaVez(sessaoId, f.id, f.hash), caso).rejects.toBeInstanceOf(
        SegundoFatorVencido,
      );
    }
    await expect(
      conferirItemUmaVez("00000000-0000-4000-8000-000000000000", alvo.id, alvo.hash),
    ).rejects.toBeInstanceOf(SegundoFatorVencido);
    // Nada foi gravado pelas recusas.
    const n = await dono.query(
      "select count(*)::int as n from acervo.conferencia_item where item_id = $1",
      [alvo.id],
    );
    expect(n.rows[0].n).toBe(0);
    // Controle positivo: o Admin com segundo fator confere.
    expect(await conferirItemUmaVez(admin, alvo.id, alvo.hash)).toBe(true);
  });

  it("conferir duas vezes o mesmo item não regrava (a primeira data vale); em paralelo ficam uma linha só", async () => {
    const [a, b] = (await ids(SLUGS.rascunho)).slice(1) as { id: string; hash: string }[];
    expect(
      await conferirItemUmaVez(admin, (a as { id: string }).id, (a as { hash: string }).hash),
    ).toBe(true);
    const antes = await dono.query<{ t: string }>(
      "select conferida_em::text as t from acervo.conferencia_item where item_id = $1",
      [(a as { id: string }).id],
    );
    expect(
      await conferirItemUmaVez(admin, (a as { id: string }).id, (a as { hash: string }).hash),
    ).toBe(false);
    const depois = await dono.query<{ t: string }>(
      "select conferida_em::text as t from acervo.conferencia_item where item_id = $1",
      [(a as { id: string }).id],
    );
    expect(depois.rows[0]?.t).toBe(antes.rows[0]?.t);
    // Duas abas ao mesmo tempo no mesmo item: nenhuma recusa, uma linha.
    const bb = b as { id: string; hash: string };
    await Promise.all([
      conferirItemUmaVez(admin, bb.id, bb.hash),
      conferirItemUmaVez(admin, bb.id, bb.hash),
    ]);
    const n = await dono.query(
      "select count(*)::int as n from acervo.conferencia_item where item_id = $1",
      [bb.id],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it("hash velho do item é recusado (40001), inclusive quando a conferência antiga ainda existe", async () => {
    const [item] = await ids(SLUGS.pronta);
    const velho = (item as { hash: string }).hash;
    await dono.query(
      "update acervo.ficha_item set texto_pt = texto_pt || ' (mudou)' where id = $1",
      [(item as { id: string }).id],
    );
    // A conferência antiga ainda está na tabela, com o hash velho; conferir com ele NÃO vira "já conferido".
    await expect(
      conferirItemUmaVez(admin, (item as { id: string }).id, velho),
    ).rejects.toBeInstanceOf(ConteudoMudou);
    const atual = (await ids(SLUGS.pronta))[0] as { id: string; hash: string };
    expect(atual.hash).not.toBe(velho);
    expect(await conferirItemUmaVez(admin, atual.id, atual.hash)).toBe(true);
  });

  it("verificar: faltam páginas (contagem), edição a confirmar, hash velho; e a verificada vale para o hash que valeu", async () => {
    const em = await dadosDaFicha(SLUGS.emConferencia);
    await expect(verificarFichaUmaVez(admin, em.id, em.hash)).rejects.toMatchObject({
      name: "FaltamPaginas",
      faltam: 2,
    });
    await expect(verificarFichaUmaVez(admin, em.id, em.hash)).rejects.toBeInstanceOf(FaltamPaginas);

    await conferirTodos(SLUGS.confirmar);
    const c = await dadosDaFicha(SLUGS.confirmar);
    await expect(verificarFichaUmaVez(admin, c.id, c.hash)).rejects.toBeInstanceOf(
      EdicaoNaoConfirmada,
    );
    expect(await lerFicha(SLUGS.confirmar)).toBeNull();

    const velho = em.hash;
    await dono.query("update acervo.ficha set tese_pt = tese_pt || ' outra' where fonte_id = $1", [
      em.id,
    ]);
    await expect(verificarFichaUmaVez(admin, em.id, velho)).rejects.toBeInstanceOf(ConteudoMudou);
    // Nenhuma verificação nasceu de nenhuma recusa.
    const n = await dono.query(
      "select count(*)::int as n from acervo.verificacao_ficha where ficha_id = any($1::uuid[])",
      [[em.id, c.id]],
    );
    expect(n.rows[0].n).toBe(0);
  });

  it("duas abas verificando a mesma ficha: uma linha, hash certo; a segunda recebe 'já verificada' com a data da primeira", async () => {
    const f = await dadosDaFicha(SLUGS.pronta);
    await conferirTodos(SLUGS.pronta);
    const f2 = await dadosDaFicha(SLUGS.pronta);
    const primeira = await verificarFichaUmaVez(admin, f2.id, f2.hash);
    expect(primeira.gravou).toBe(true);
    const segunda = await verificarFichaUmaVez(admin, f2.id, f2.hash);
    expect(segunda.gravou).toBe(false);
    expect(segunda.verificadaEm.getTime()).toBe(primeira.verificadaEm.getTime());
    const linhas = await dono.query<{ ficha_hash: string }>(
      "select ficha_hash from acervo.verificacao_ficha where ficha_id = $1",
      [f2.id],
    );
    expect(linhas.rows).toEqual([{ ficha_hash: f2.hash }]);
    expect((await lerFicha(SLUGS.pronta))?.slug).toBe(SLUGS.pronta);
    void f;
    // Verificar com o hash VELHO da verificação, depois de a ficha mudar, não vira "já verificada": é recusado.
    await dono.query("update acervo.ficha set tese_pt = tese_pt || ' depois' where fonte_id = $1", [
      f2.id,
    ]);
    await expect(verificarFichaUmaVez(admin, f2.id, f2.hash)).rejects.toBeInstanceOf(ConteudoMudou);
    expect(await lerFicha(SLUGS.pronta)).toBeNull();
  });

  it("verificação em paralelo (duas abas ao mesmo tempo): termina verificada, uma linha, nenhuma recusa", async () => {
    const [, , ultimo] = await ids(SLUGS.rascunho);
    await conferirTodos(SLUGS.rascunho);
    void ultimo;
    const f = await dadosDaFicha(SLUGS.rascunho);
    const rs = await Promise.all([
      verificarFichaUmaVez(admin, f.id, f.hash),
      verificarFichaUmaVez(admin, f.id, f.hash),
    ]);
    expect(rs.some((r) => r.gravou)).toBe(true);
    const linhas = await dono.query<{ ficha_hash: string }>(
      "select ficha_hash from acervo.verificacao_ficha where ficha_id = $1",
      [f.id],
    );
    expect(linhas.rows).toEqual([{ ficha_hash: f.hash }]);
  });
});
