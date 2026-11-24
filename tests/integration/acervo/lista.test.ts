import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { listarFontesPorNivel } from "@/modules/acervo/consultas-lista";
import { lerNivelDoParametro } from "@/modules/acervo/niveis";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Lista do Acervo (ACER-01, D-13): só Fonte publicada, só ficha verificada, grupos na ordem fixa, Nível sem
// Fonte nunca oferecido, e o parâmetro de Nível nunca vai à consulta. Cria Fontes de teste, então usa um
// banco descartável SÓ deste arquivo e não roda no Neon. A leitura passa pela porta `comAcervo` (papel do
// aplicativo, política de linha valendo); a escrita nasce pelos papéis de carga e do dono do esquema.

const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let migra: pg.Client;
let fichaId: string;

async function conectar(papel: "carga" | "migra"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

async function fonteIntegral(
  slug: string,
  titulo: string,
  nivel: "primaria" | "confessional",
  publicada: boolean,
  autor: string,
  epoca: string,
): Promise<void> {
  await carga.query(
    `insert into acervo.fonte (slug, titulo, autor, epoca, nivel, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
     values ($1, $2, $3, $4, $5, 'integral', 'en', 'dominio-publico', 'Origem de teste', 'https://exemplo.invalid/x', $6)`,
    [slug, titulo, autor, epoca, nivel, publicada],
  );
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = await conectar("carga");
  migra = await conectar("migra");

  // Duas Fontes primárias publicadas fora da ordem alfabética (com acento, para provar `pt-BR`).
  await fonteIntegral("zeta-obra", "Zeta, a obra", "primaria", true, "Autor Zeta", "século II");
  await fonteIntegral(
    "alef-obra",
    "Álef, a obra",
    "primaria",
    true,
    "Autor Álef",
    "cerca de 93 d.C.",
  );
  // Não publicada: nunca aparece.
  await fonteIntegral("oculta-obra", "Obra oculta", "primaria", false, "Autor X", "século I");

  // Ficha em rascunho (sem verificação): nunca aparece.
  const f = await carga.query<{ id: string }>(
    `insert into acervo.fonte (slug, titulo, autor, nivel, tipo_texto, idioma, obra_protegida, publicada)
     values ('ficha-de-teste', 'Ficha de teste', 'Estudiosa de Teste', 'academica', 'ficha', 'en', true, false)
     returning id`,
  );
  fichaId = (f.rows[0] as { id: string }).id;
  await carga.query(
    `insert into acervo.ficha (fonte_id, edicao_consultada, ano, editora, tese_pt, idioma_trechos, conteudo_hash)
     values ($1, '1ª edição de teste', 2001, 'Editora de Teste', 'Tese de teste.', 'en', $2)`,
    [fichaId, "a".repeat(64)],
  );
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await migra?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

const slugs = (grupos: { fontes: { slug: string }[] }[]) =>
  grupos.flatMap((g) => g.fontes.map((f) => f.slug));

describe.skipIf(emNeon())("lista do Acervo", () => {
  it("controle positivo: o dado de teste existe (as quatro Fontes e a ficha estão no banco)", async () => {
    const n = await migra.query("select count(*)::int as n from acervo.fonte");
    expect(n.rows[0].n).toBe(4);
    const ficha = await migra.query("select count(*)::int as n from acervo.ficha");
    expect(ficha.rows[0].n).toBe(1);
  });

  it("Fonte não publicada e ficha em rascunho não aparecem; o Nível da ficha não é oferecido", async () => {
    const lista = await listarFontesPorNivel(null);
    expect(slugs(lista.grupos).sort()).toEqual(["alef-obra", "zeta-obra"]);
    expect(lista.oferecidos).toEqual([{ nivel: "primaria", total: 2 }]);
    expect(lista.total).toBe(2);
  });

  it("agrupa pela ordem fixa e ordena por título em português dentro do Nível", async () => {
    const lista = await listarFontesPorNivel(null);
    expect(lista.grupos.map((g) => g.nivel)).toEqual(["primaria"]);
    // "Álef" vem antes de "Zeta" com `localeCompare('pt-BR')`.
    expect(lista.grupos[0]?.fontes.map((f) => f.slug)).toEqual(["alef-obra", "zeta-obra"]);
    expect(lista.grupos[0]?.fontes[0]).toMatchObject({
      titulo: "Álef, a obra",
      autor: "Autor Álef",
      epoca: "cerca de 93 d.C.",
      idioma: "en",
      tipo: "integral",
      ano: null,
    });
  });

  it("Nível sem Fonte pedido pela URL: lista completa, sem filtro, com a marca de aviso", async () => {
    const lista = await listarFontesPorNivel("confessional");
    expect(lista.nivelSemFonte).toBe(true);
    expect(lista.nivelAplicado).toBeNull();
    expect(slugs(lista.grupos).sort()).toEqual(["alef-obra", "zeta-obra"]);
    // A ficha em rascunho também não torna "Pesquisa acadêmica" um Nível com Fonte.
    const academica = await listarFontesPorNivel("academica");
    expect(academica.nivelSemFonte).toBe(true);
  });

  it("valor malicioso do parâmetro vira 'sem filtro' e a lista volta inteira, sem erro", async () => {
    for (const valor of [
      "primaria' or '1'='1",
      "%",
      "'; drop table acervo.fonte; --",
      ["primaria"],
    ]) {
      const nivel = lerNivelDoParametro(valor);
      expect(nivel).toBeNull();
      const lista = await listarFontesPorNivel(nivel);
      expect(lista.nivelSemFonte).toBe(false);
      expect(slugs(lista.grupos)).toHaveLength(2);
    }
    // A tabela continua lá (o valor nunca virou SQL).
    const n = await migra.query("select count(*)::int as n from acervo.fonte");
    expect(n.rows[0].n).toBe(4);
  });

  it("filtra por Nível e a contagem é a do Nível", async () => {
    const lista = await listarFontesPorNivel("primaria");
    expect(lista.nivelAplicado).toBe("primaria");
    expect(lista.nivelSemFonte).toBe(false);
    expect(lista.totalMostrado).toBe(2);
    expect(lista.grupos.map((g) => g.nivel)).toEqual(["primaria"]);
  });

  it("ficha verificada entra no Nível 'Pesquisa acadêmica', com o ano; verificação velha a tira", async () => {
    const hash = (
      await migra.query<{ conteudo_hash: string }>(
        "select conteudo_hash from acervo.ficha where fonte_id = $1",
        [fichaId],
      )
    ).rows[0]?.conteudo_hash as string;
    // Evidência com hash que NÃO é o do conteúdo: continua rascunho.
    await migra.query(
      "insert into acervo.verificacao_ficha (ficha_id, ficha_hash) values ($1, $2)",
      [fichaId, "b".repeat(64)],
    );
    expect(slugs((await listarFontesPorNivel(null)).grupos)).not.toContain("ficha-de-teste");

    // Hash igual ao do conteúdo atual: verificada, aparece.
    await migra.query("update acervo.verificacao_ficha set ficha_hash = $2 where ficha_id = $1", [
      fichaId,
      hash,
    ]);
    const lista = await listarFontesPorNivel(null);
    expect(lista.grupos.map((g) => g.nivel)).toEqual(["primaria", "academica"]);
    expect(lista.oferecidos).toEqual([
      { nivel: "primaria", total: 2 },
      { nivel: "academica", total: 1 },
    ]);
    expect(lista.grupos[1]?.fontes[0]).toMatchObject({
      slug: "ficha-de-teste",
      tipo: "ficha",
      ano: 2001,
      autor: "Estudiosa de Teste",
    });

    const so = await listarFontesPorNivel("academica");
    expect(so.nivelAplicado).toBe("academica");
    expect(so.grupos.map((g) => g.nivel)).toEqual(["academica"]);

    // O conteúdo muda (o banco recalcula o hash): a ficha volta a ser rascunho e o Nível some do filtro.
    await carga.query("update acervo.ficha set tese_pt = 'Tese alterada.' where fonte_id = $1", [
      fichaId,
    ]);
    const depois = await listarFontesPorNivel(null);
    expect(depois.oferecidos).toEqual([{ nivel: "primaria", total: 2 }]);
  });
});
