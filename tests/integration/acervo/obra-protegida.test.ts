import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// ACER-09 e D-19 no banco: obra protegida e ficha nunca guardam texto integral, nem na inserção do
// parágrafo nem por mudança posterior da Fonte, para o papel de carga E para o dono do esquema; e a
// ficha tem teto de citação. Cria dado de teste: banco descartável SÓ deste arquivo, fora do Neon.

const emNeon = () => inject("alvoBanco") === "neon";
const HASH = "a".repeat(64);
const RECUSA = /texto integral recusado/;

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let migra: pg.Client;

async function cliente(papel: "carga" | "migra"): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: urlDoPapel(papel, { agrupada: false }) });
  await c.connect();
  return c;
}

type Quem = "carga" | "migra";
const quem = (q: Quem) => (q === "carga" ? carga : migra);

let n = 0;
/** Fonte com uma seção, pelo papel pedido. Integral não protegida ou ficha (protegida ou não). */
async function criarFonte(q: Quem, tipo: "integral" | "ficha", protegida: boolean) {
  n++;
  const slug = `fonte-de-teste-${n}`;
  const integral = tipo === "integral";
  const f = await quem(q).query<{ id: string }>(
    `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, obra_protegida, licenca, origem_url, origem_nome)
     values ($1, 'Fonte de Teste', 'academica', $2, 'en', $3, $4, $5, $6) returning id`,
    [
      slug,
      tipo,
      protegida,
      integral ? "dominio-publico" : null,
      integral ? "https://exemplo.invalid/t" : null,
      integral ? "Origem de Teste" : null,
    ],
  );
  const fonteId = (f.rows[0] as { id: string }).id;
  const secaoId = `${slug}/1`;
  await quem(q).query(
    "insert into acervo.fonte_secao (id, fonte_id, ordem, slug, titulo) values ($1, $2, 1, '1', 'Seção')",
    [secaoId, fonteId],
  );
  return { slug, fonteId, secaoId };
}

const paragrafo = (q: Quem, secaoId: string, ref: string, texto = "Texto de teste.") =>
  quem(q).query(
    "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ($1, $2, 1, $3, $4)",
    [`${secaoId}#${ref}`, secaoId, texto, ref],
  );

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = await cliente("carga");
  migra = await cliente("migra");
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  for (const c of [carga, migra]) await c?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("ACER-09: texto integral recusado na inserção do parágrafo", () => {
  it.each(["carga", "migra"] as const)(
    "como %s: parágrafo em Fonte de obra protegida (ficha) falha com 23514",
    async (q) => {
      const f = await criarFonte(q, "ficha", true);
      await expect(paragrafo(q, f.secaoId, "1")).rejects.toMatchObject({ code: "23514" });
      await expect(paragrafo(q, f.secaoId, "1")).rejects.toThrow(RECUSA);
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: parágrafo em Fonte que não é de texto integral, mesmo sem a marca de obra protegida",
    async (q) => {
      const f = await criarFonte(q, "ficha", false);
      await expect(paragrafo(q, f.secaoId, "1")).rejects.toMatchObject({ code: "23514" });
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: mudar o parágrafo de seção para uma Fonte protegida também falha",
    async (q) => {
      const livre = await criarFonte(q, "integral", false);
      await paragrafo(q, livre.secaoId, "1");
      const protegida = await criarFonte(q, "ficha", true);
      await expect(
        quem(q).query("update acervo.fonte_paragrafo set secao_id = $1 where secao_id = $2", [
          protegida.secaoId,
          livre.secaoId,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );

  it.each(["carga", "migra"] as const)(
    "controle positivo, como %s: Fonte integral não protegida aceita e atualiza o parágrafo",
    async (q) => {
      const f = await criarFonte(q, "integral", false);
      await paragrafo(q, f.secaoId, "1");
      await quem(q).query(
        "update acervo.fonte_paragrafo set texto = 'Outro texto.' where secao_id = $1",
        [f.secaoId],
      );
      const r = await quem(q).query(
        "select texto from acervo.fonte_paragrafo where secao_id = $1",
        [f.secaoId],
      );
      expect(r.rows).toEqual([{ texto: "Outro texto." }]);
    },
  );
});

describe.skipIf(emNeon())("ACER-09: a Fonte não vira obra protegida depois de ter texto", () => {
  it.each(["carga", "migra"] as const)(
    "como %s: tipo_texto 'ficha' em Fonte com parágrafo falha com 23514",
    async (q) => {
      const f = await criarFonte(q, "integral", false);
      await paragrafo(q, f.secaoId, "1");
      await expect(
        quem(q).query("update acervo.fonte set tipo_texto = 'ficha' where id = $1", [f.fonteId]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        quem(q).query("update acervo.fonte set tipo_texto = 'ficha' where id = $1", [f.fonteId]),
      ).rejects.toThrow(RECUSA);
    },
  );

  it.each(["carga", "migra"] as const)(
    "como %s: obra_protegida verdadeira em Fonte com parágrafo falha com 23514",
    async (q) => {
      const f = await criarFonte(q, "integral", false);
      await paragrafo(q, f.secaoId, "1");
      await expect(
        quem(q).query("update acervo.fonte set obra_protegida = true where id = $1", [f.fonteId]),
      ).rejects.toMatchObject({ code: "23514" });
      // Nada mudou: a Fonte continua integral e não protegida.
      const r = await quem(q).query(
        "select obra_protegida, tipo_texto from acervo.fonte where id = $1",
        [f.fonteId],
      );
      expect(r.rows).toEqual([{ obra_protegida: false, tipo_texto: "integral" }]);
    },
  );

  it.each(["carga", "migra"] as const)(
    "controle positivo, como %s: Fonte sem parágrafo muda de tipo, e Fonte com parágrafo muda de título",
    async (q) => {
      const vazia = await criarFonte(q, "integral", false);
      await quem(q).query(
        "update acervo.fonte set tipo_texto = 'ficha', obra_protegida = true where id = $1",
        [vazia.fonteId],
      );
      const cheia = await criarFonte(q, "integral", false);
      await paragrafo(q, cheia.secaoId, "1");
      await quem(q).query(
        "update acervo.fonte set titulo = 'Novo título', tipo_texto = 'integral' where id = $1",
        [cheia.fonteId],
      );
      const r = await quem(q).query("select titulo from acervo.fonte where id = $1", [
        cheia.fonteId,
      ]);
      expect(r.rows).toEqual([{ titulo: "Novo título" }]);
    },
  );
});

describe.skipIf(emNeon())("D-19: tetos de citação na ficha", () => {
  let fichaId: string;

  beforeAll(async () => {
    const f = await criarFonte("carga", "ficha", true);
    fichaId = f.fonteId;
    await carga.query(
      `insert into acervo.ficha (fonte_id, edicao_consultada, tese_pt, idioma_trechos, conteudo_hash)
       values ($1, 'Edição de teste', 'Tese de teste.', 'en', $2)`,
      [fichaId, HASH],
    );
  });

  let ordem = 0;
  const item = (trecho: string | null, texto: string) => {
    ordem++;
    return carga.query(
      `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, pagina_inicio, pagina_fim,
         trecho_original, idioma_trecho, confianca, conteudo_hash)
       values ($1, $2, 'trecho', $3, $4, 5, 5, $5, 'en', 'media', $6)`,
      [`obra-de-teste/trecho-${ordem}`, fichaId, ordem, texto, trecho, HASH],
    );
  };

  it("trecho_original de 301 caracteres falha e de 300 passa", async () => {
    await expect(item("x".repeat(301), "Texto.")).rejects.toMatchObject({ code: "23514" });
    await expect(item("x".repeat(300), "Texto.")).resolves.toBeDefined();
  });

  it("texto_pt de 2001 caracteres falha e de 2000 passa", async () => {
    await expect(item(null, "y".repeat(2001))).rejects.toMatchObject({ code: "23514" });
    await expect(item(null, "y".repeat(2000))).resolves.toBeDefined();
  });

  it("item sem página, com faixa invertida ou sem idioma do trecho falha", async () => {
    ordem++;
    const base = (colunas: string, valores: string) =>
      carga.query(
        `insert into acervo.ficha_item (id, ficha_id, tipo, ordem, texto_pt, ${colunas}, confianca, conteudo_hash)
         values ('obra-de-teste/argumento-${ordem}', $1, 'argumento', ${ordem}, 'Texto.', ${valores}, 'alta', $2)`,
        [fichaId, HASH],
      );
    await expect(base("pagina_texto", "null")).rejects.toMatchObject({ code: "23514" });
    await expect(base("pagina_inicio, pagina_fim", "9, 3")).rejects.toMatchObject({
      code: "23514",
    });
    await expect(base("pagina_inicio, trecho_original", "9, 'sem idioma'")).rejects.toMatchObject({
      code: "23514",
    });
    // Controle positivo: página só em texto ("xi-xii") é aceita.
    await expect(base("pagina_texto", "'xi-xii'")).resolves.toBeDefined();
  });

  it("a ficha sem edição consultada não existe", async () => {
    const outra = await criarFonte("carga", "ficha", true);
    await expect(
      carga.query(
        `insert into acervo.ficha (fonte_id, edicao_consultada, tese_pt, idioma_trechos, conteudo_hash)
         values ($1, '   ', 'Tese.', 'en', $2)`,
        [outra.fonteId, HASH],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
