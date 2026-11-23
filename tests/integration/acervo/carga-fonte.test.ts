import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { lerSecao } from "@/modules/acervo/consultas";
import {
  type Derivado,
  type FonteYaml,
  interpretarDerivado,
  interpretarFonteYaml,
} from "@/modules/acervo/schemas";
import { carregarFontes } from "../../../scripts/acervo/carregar";
import { ErroCarga } from "../../../scripts/ingest/carregar-biblia";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// Do derivado ao banco e à leitura: o recorte real do Josefo (Whiston, pelo Perseus) é carregado com o
// contrato, a numeração da obra vira id estável e a segunda carga não muda nada. Cria Fontes e Citações
// de teste, então usa um banco descartável SÓ deste arquivo e não roda no Neon.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const emNeon = () => inject("alvoBanco") === "neon";

let banco: BancoDeExecucao | undefined;
let carga: pg.Client;
let dono: pg.Client;

const fonteDaFixture = (): FonteYaml =>
  interpretarFonteYaml(
    readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8"),
    "josefo-antiguidades.yaml",
  );
// biome-ignore lint/suspicious/noExplicitAny: o teste mexe no JSON bruto para fabricar derivados defeituosos
const derivadoDaFixture = (alterar?: (bruto: Record<string, any>) => void): Derivado => {
  const bruto = JSON.parse(
    readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
  );
  alterar?.(bruto);
  return interpretarDerivado(bruto, "josefo-antiguidades.json");
};

async function um<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await dono.query<T>(sql, params)).rows[0];
}
const contar = async (sql: string, params: unknown[] = []) =>
  Number((await um<{ n: string }>(sql, params))?.n ?? -1);

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  carga = new pg.Client({ connectionString: urlDoPapel("carga", { agrupada: false }) });
  await carga.connect();
  dono = new pg.Client({ connectionString: preparado.banco.url });
  await dono.connect();
}, 120_000);

afterAll(async () => {
  if (emNeon()) return;
  await carga?.end().catch(() => {});
  await dono?.end().catch(() => {});
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("carga da Fonte a partir do derivado", () => {
  it("carrega as duas seções e o parágrafo 18.63 com o texto de Whiston, sem nota de editor", async () => {
    const r = await carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
      cliente: carga,
    });
    expect(r.fontes.inseridos).toBe(1);
    expect(r.secoes.inseridos).toBe(2);
    expect(r.paragrafos.inseridos).toBe(2);

    const secoes = await dono.query<{ id: string; slug: string }>(
      `select s.id, s.slug from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id
        where f.slug = 'josefo-antiguidades' order by s.ordem`,
    );
    expect(secoes.rows.map((s) => s.id)).toEqual([
      "josefo-antiguidades/18",
      "josefo-antiguidades/20",
    ]);

    const p = await um<{ texto: string; ref: string; idioma: string; notas: unknown[] }>(
      "select texto, ref, idioma, notas from acervo.fonte_paragrafo where id = 'josefo-antiguidades/18.63'",
    );
    expect(p?.texto).toContain("wise man");
    expect(p?.ref).toBe("18.63");
    expect(p?.idioma).toBe("en");
    expect(p?.notas).toEqual([]);

    const todos = await dono.query<{ texto: string }>("select texto from acervo.fonte_paragrafo");
    for (const { texto } of todos.rows) {
      expect(texto).not.toContain("It hence evidently appears");
      expect(texto).not.toContain("Reland");
      expect(texto).not.toContain("<note");
    }
  });

  it("guarda a faixa de Niese do parágrafo 20.197 (197 a 203) e a frase sobre Tiago", async () => {
    const p = await um<{ texto: string; ref_inicio: number; ref_fim: number }>(
      "select texto, ref_inicio, ref_fim from acervo.fonte_paragrafo where id = 'josefo-antiguidades/20.197'",
    );
    expect(p?.ref_inicio).toBe(197);
    expect(p?.ref_fim).toBe(203);
    expect(p?.texto).toContain("brother of Jesus");
  });

  it("guarda o resumo e as palavras-chave em português da seção", async () => {
    const s = await um<{ resumo_pt: string; palavras_chave_pt: string[] }>(
      "select resumo_pt, palavras_chave_pt from acervo.fonte_secao where id = 'josefo-antiguidades/18'",
    );
    expect(s?.resumo_pt).toContain("Pilatos");
    expect(s?.palavras_chave_pt).toEqual(["Jesus", "Pilatos", "cristãos"]);
  });

  it("a segunda carga não muda nada: inseridos=0 e atualizados=0", async () => {
    const r = await carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
      cliente: carga,
    });
    expect(r.inseridos).toBe(0);
    expect(r.atualizados).toBe(0);
    expect(r.removidos).toBe(0);
    expect(r.inalterados).toBe(5);
  });

  it("texto que muda no derivado é atualizado", async () => {
    const mudado = derivadoDaFixture((b) => {
      b.secoes[0].paragrafos[0].texto = `${b.secoes[0].paragrafos[0].texto} (revisado)`;
    });
    const r = await carregarFontes([{ fonte: fonteDaFixture(), derivado: mudado }], {
      cliente: carga,
    });
    expect(r.paragrafos.atualizados).toBe(1);
    expect(r.inseridos).toBe(0);
    // volta ao texto original para os testes seguintes
    await carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
      cliente: carga,
    });
  });

  it("parágrafo que sumiu do derivado e não tem Citação é apagado", async () => {
    const com = derivadoDaFixture((b) => {
      b.secoes[0].paragrafos.push({ ref: "18.65", texto: "Um parágrafo de teste a mais." });
    });
    await carregarFontes([{ fonte: fonteDaFixture(), derivado: com }], { cliente: carga });
    expect(await contar("select count(*) as n from acervo.fonte_paragrafo")).toBe(3);

    const r = await carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
      cliente: carga,
    });
    expect(r.paragrafos.removidos).toBe(1);
    expect(await contar("select count(*) as n from acervo.fonte_paragrafo")).toBe(2);
  });

  it("parágrafo que sumiu do derivado e tem Citação faz a carga falhar sem apagar nada", async () => {
    const com = derivadoDaFixture((b) => {
      b.secoes[0].paragrafos.push({ ref: "18.65", texto: "Um parágrafo citado." });
    });
    await carregarFontes([{ fonte: fonteDaFixture(), derivado: com }], { cliente: carga });
    await dono.query(
      `insert into acervo.afirmacao (id, texto, texto_hash) values ('teste-a1', 'Frase de teste.', repeat('a', 64))`,
    );
    await dono.query(
      `insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id)
       values ('teste-a1', 'josefo-antiguidades/18.65')`,
    );
    const antes = await contar("select count(*) as n from acervo.fonte_paragrafo");

    await expect(
      carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
        cliente: carga,
      }),
    ).rejects.toThrow(ErroCarga);
    expect(await contar("select count(*) as n from acervo.fonte_paragrafo")).toBe(antes);

    await dono.query("delete from acervo.citacao where afirmacao_id = 'teste-a1'");
    await dono.query("delete from acervo.afirmacao where id = 'teste-a1'");
    await carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
      cliente: carga,
    });
  });

  it("recusa derivado de outra Fonte e seção do YAML que o derivado não tem", async () => {
    const outro = derivadoDaFixture((b) => {
      b.slug = "outra-fonte";
    });
    await expect(
      carregarFontes([{ fonte: fonteDaFixture(), derivado: outro }], { cliente: carga }),
    ).rejects.toThrow(ErroCarga);

    const semSecao = derivadoDaFixture((b) => {
      b.secoes.splice(1, 1);
    });
    await expect(
      carregarFontes([{ fonte: fonteDaFixture(), derivado: semSecao }], { cliente: carga }),
    ).rejects.toThrow(/seção 20/);
  });

  it("a carga nunca toca numa Fonte criada pelo painel", async () => {
    await dono.query(
      "update acervo.fonte set origem_registro = 'painel' where slug = 'josefo-antiguidades'",
    );
    await expect(
      carregarFontes([{ fonte: fonteDaFixture(), derivado: derivadoDaFixture() }], {
        cliente: carga,
      }),
    ).rejects.toThrow(/painel/);
    await dono.query(
      "update acervo.fonte set origem_registro = 'arquivo' where slug = 'josefo-antiguidades'",
    );
  });
});

describe.skipIf(emNeon())("restrições do banco (ACER-09)", () => {
  const inserir = (campos: string, valores: string) =>
    carga.query(
      `insert into acervo.fonte (slug, nivel, titulo, ${campos}) values ('t-restricao', 'primaria', 'T', ${valores})`,
    );

  it("obra protegida não pode ter texto integral", async () => {
    await expect(
      inserir(
        "tipo_texto, obra_protegida, licenca, origem_url",
        "'integral', true, 'dominio-publico', 'https://exemplo.org/'",
      ),
    ).rejects.toMatchObject({ constraint: "fonte_obra_protegida_sem_texto_integral" });
  });

  it("texto integral exige código de licença", async () => {
    await expect(
      inserir("tipo_texto, origem_url", "'integral', 'https://exemplo.org/'"),
    ).rejects.toMatchObject({ constraint: "fonte_texto_integral_exige_licenca_e_origem" });
  });

  it("texto integral exige origem em https (http e ausente são recusados)", async () => {
    await expect(
      inserir(
        "tipo_texto, licenca, origem_url",
        "'integral', 'dominio-publico', 'http://exemplo.org/'",
      ),
    ).rejects.toMatchObject({ constraint: "fonte_texto_integral_exige_licenca_e_origem" });
    await expect(
      inserir("tipo_texto, licenca", "'integral', 'dominio-publico'"),
    ).rejects.toMatchObject({ constraint: "fonte_texto_integral_exige_licenca_e_origem" });
  });

  it("ficha sem licença nem origem é aceita (a regra é só do texto integral)", async () => {
    await inserir("tipo_texto", "'ficha'");
    await carga.query("delete from acervo.fonte where slug = 't-restricao'");
  });
});

describe.skipIf(emNeon())("leitura da seção pelo Estudante", () => {
  it("lê a seção 18 com o parágrafo, a Fonte e a vizinha", async () => {
    const s = await lerSecao("josefo-antiguidades", "18");
    expect(s).not.toBeNull();
    expect(s?.fonte).toMatchObject({
      slug: "josefo-antiguidades",
      nivel: "primaria",
      idioma: "en",
      tradutor: "William Whiston",
      traduzidaPorNos: false,
    });
    expect(s?.secao).toMatchObject({ indice: 1, total: 2, anterior: null });
    expect(s?.secao.proxima?.slug).toBe("20");
    expect(s?.paragrafos.map((p) => p.ref)).toEqual(["18.63"]);
    expect(s?.paragrafos[0]?.texto).toContain("wise man");
  });

  it("Fonte inexistente, seção inexistente e Fonte não publicada dão null", async () => {
    expect(await lerSecao("nao-existe", "18")).toBeNull();
    expect(await lerSecao("josefo-antiguidades", "99")).toBeNull();
    await dono.query(
      "update acervo.fonte set publicada = false where slug = 'josefo-antiguidades'",
    );
    try {
      expect(await lerSecao("josefo-antiguidades", "18")).toBeNull();
    } finally {
      await dono.query(
        "update acervo.fonte set publicada = true where slug = 'josefo-antiguidades'",
      );
    }
  });
});
