import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpretarOrigem } from "../../../scripts/ingest/acervo-interpretar";
import { ErroLicenca } from "../../../scripts/ingest/acervo-licenca";
import { FORMATOS_ORIGEM } from "../../../scripts/ingest/acervo-origens";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const ler = (nome: string) => readFileSync(path.join(FIXTURES, nome), "utf8");
const FOWLER = {
  tradutores: ["Henry Watson Fowler", "Francis George Fowler"],
  licenca: "CC BY-SA",
};

describe("interpretarOrigem", () => {
  it("tei: confere o cabeçalho e devolve seções, parágrafos, notas e o aviso editorial", () => {
    const r = interpretarOrigem("tei", ler("perseus-tacito-trecho.xml"), {
      verificador: {
        tradutores: ["Alfred John Church", "William Jackson Brodribb"],
        licenca: "Attribution-ShareAlike 4.0",
      },
    });
    expect(r.secoes[0]?.paragrafos.some((p) => p.ref === "15.44")).toBe(true);
    expect(r.cabecalho.avisoEditorial).toContain("1942");
    expect(Array.isArray(r.notas)).toBe(true);
  });

  it("tei: o rótulo do livro vem da configuração", () => {
    const r = interpretarOrigem("tei", ler("perseus-josefo-trecho.xml"), {
      verificador: { tradutores: ["William Whiston"], licenca: "CC BY-SA" },
      rotuloLivro: "Livro",
    });
    expect(r.secoes[0]?.titulo).toBe("Livro 18");
  });

  it("controle negativo: o cabeçalho de Harmon reprova ANTES de qualquer leitura do corpo", () => {
    expect(() =>
      interpretarOrigem("tei", ler("perseus-luciano-eng2-cabecalho.xml"), { verificador: FOWLER }),
    ).toThrow(ErroLicenca);
  });

  it("controle positivo: o eng4 de Luciano passa e vira uma seção só", () => {
    const r = interpretarOrigem("tei", ler("perseus-luciano-eng4-trecho.xml"), {
      verificador: FOWLER,
    });
    expect(r.secoes).toHaveLength(1);
  });

  it("formato desconhecido lança erro com o nome do formato", () => {
    expect(() =>
      interpretarOrigem("rtf", "<x/>", { verificador: { tradutores: ["x"], licenca: "x" } }),
    ).toThrow(/rtf/);
  });
});

// ---- formatos do plano 02-27: Gutenberg (texto) e HTML (página do tradutor) ----
const lerBruto = (nome: string, charset: BufferEncoding = "utf8") =>
  readFileSync(path.join(FIXTURES, nome), charset);
const DECLARACAO_PG =
  "Creating the works from public domain print editions means that no one owns a United States copyright in these works";
const MELMOTH = { tradutores: ["William Melmoth", "F. C. T. Bosanquet"], licenca: DECLARACAO_PG };
const THOMSON = { tradutores: ["Alexander Thomson", "T.Forester"], licenca: DECLARACAO_PG };
const GUTENBERG = {
  estrutura: "cartas" as const,
  secoes: ["trajano"],
  correspondencia: { "trajano.XCVII": "10.96", "trajano.XCVIII": "10.97" },
};
const MATTISON = {
  tradutores: ["Mark M. Mattison"],
  licenca:
    "The following translation has been committed to the public domain and may be freely copied and used, changed or unchanged, for any purpose.",
};

describe("interpretarOrigem: gutenberg", () => {
  const plinio = lerBruto("gutenberg-plinio-trecho.txt", "latin1");
  const bordas = lerBruto("gutenberg-suetonio-bordas.txt");

  it("confere a licença nas bordas e devolve as cartas com a numeração da tabela, as notas e os relatórios", () => {
    const r = interpretarOrigem("gutenberg", plinio, {
      verificador: MELMOTH,
      gutenberg: GUTENBERG,
    });
    expect(r.secoes[0]?.paragrafos.map((p) => p.ref)).toEqual(["trajano.I", "10.96", "10.97"]);
    expect(r.secoes[0]?.paragrafos[1]?.texto).toContain("Christians");
    expect(r.notas).toHaveLength(5);
    expect(r.ausentes).toHaveLength(95);
    expect(r.foraDaTabela).toEqual(["trajano.I"]);
    expect(r.cabecalho.avisoEditorial).toBe("");
    expect("borda" in r.cabecalho && r.cabecalho.borda).toBe("fim");
  });

  it("controle negativo: as bordas do Suetônio reprovam a licença ANTES de qualquer leitura do corpo", () => {
    expect(() =>
      interpretarOrigem("gutenberg", bordas, {
        verificador: THOMSON,
        gutenberg: { estrutura: "cartas", secoes: ["x"] },
      }),
    ).toThrow(ErroLicenca);
  });

  it("gutenberg sem a configuração da estrutura no registro reprova, dizendo o que falta", () => {
    expect(() => interpretarOrigem("gutenberg", plinio, { verificador: MELMOTH })).toThrow(
      /estrutura/,
    );
  });

  it("tradutor esperado que não está no arquivo reprova pelo nome dele", () => {
    expect(() =>
      interpretarOrigem("gutenberg", plinio, {
        verificador: { ...MELMOTH, tradutores: ["Austin Morris Harmon"] },
        gutenberg: GUTENBERG,
      }),
    ).toThrow(/Austin Morris Harmon/);
  });
});

describe("interpretarOrigem: html", () => {
  const tome = lerBruto("gospels-tome-trecho.html");

  it("confere a dedicação na página e devolve os ditos", () => {
    const r = interpretarOrigem("html", tome, {
      verificador: MATTISON,
      html: { rotuloUnidade: "Saying" },
    });
    expect(r.secoes[0]?.paragrafos.map((p) => p.ref)).toEqual(["1", "2", "3"]);
    expect(r.notas.join(" ")).toContain("committed to the public domain");
    expect(r.ausentes).toBeUndefined();
  });

  it("página sem a dedicação reprova a licença antes do corpo", () => {
    const sem = tome.replace("committed to the public domain", "all rights reserved");
    expect(sem).not.toBe(tome);
    expect(() =>
      interpretarOrigem("html", sem, { verificador: MATTISON, html: { rotuloUnidade: "Saying" } }),
    ).toThrow(ErroLicenca);
  });

  it("html sem o rótulo da unidade no registro reprova, dizendo o que falta", () => {
    expect(() => interpretarOrigem("html", tome, { verificador: MATTISON })).toThrow(
      /rotulo_unidade/,
    );
  });
});

describe("interpretarOrigem: formato registrado e ainda sem parser", () => {
  it("texto-ocr (James 1924) reprova dizendo que não tem parser: nenhum derivado sai dele", () => {
    expect(() =>
      interpretarOrigem("texto-ocr", "qualquer texto", {
        verificador: { tradutores: ["x"], licenca: "x" },
      }),
    ).toThrow(/texto-ocr/);
    expect(() =>
      interpretarOrigem("texto-ocr", "qualquer texto", {
        verificador: { tradutores: ["x"], licenca: "x" },
      }),
    ).toThrow(/sem parser/);
  });

  it("o registro real aceita os cinco formatos e recusa qualquer outro", () => {
    expect(FORMATOS_ORIGEM).toEqual(["tei", "gutenberg", "html", "thml", "texto-ocr"]);
    expect(() =>
      interpretarOrigem("pdf", "x", { verificador: { tradutores: ["x"], licenca: "x" } }),
    ).toThrow(/formato de origem desconhecido/);
  });
});

// ---- formato do plano 02-08: ThML (CCEL) ----
const maraThml = ler("ccel-anf08-mara.xml");
const SCHAFF_THML = { tradutores: ["Schaff, Philip (1819-1893)"], licenca: "Public Domain" };

describe("interpretarOrigem: thml (CCEL)", () => {
  it("confere o DC.Rights e devolve seções, parágrafos com id da edição, notas à parte e a editora lida", () => {
    const r = interpretarOrigem("thml", maraThml, {
      verificador: SCHAFF_THML,
      thml: { divisaoSecao: "div2" },
    });
    expect(r.secoes).toHaveLength(1);
    expect(r.secoes[0]?.slug).toBe("ix-xvii");
    expect(r.secoes[0]?.paragrafos.some((p) => p.ref === "ix.xvii-p5")).toBe(true);
    expect(r.notas.length).toBeGreaterThan(0);
    expect(r.cabecalho.licenca).toBe("Public Domain");
    expect("editora" in r.cabecalho && r.cabecalho.editora).toBe(
      "Grand Rapids, MI: Christian Classics Ethereal Library",
    );
  });

  it("o DC.Rights é conferido ANTES de o corpo ser lido: valor trocado reprova", () => {
    const trocado = maraThml.replace(
      "<DC.Rights>Public Domain</DC.Rights>",
      "<DC.Rights>All rights reserved</DC.Rights>",
    );
    expect(() =>
      interpretarOrigem("thml", trocado, {
        verificador: SCHAFF_THML,
        thml: { divisaoSecao: "div2" },
      }),
    ).toThrow(ErroLicenca);
  });

  it("thml sem `divisao_secao` no registro reprova, dizendo o que falta", () => {
    expect(() => interpretarOrigem("thml", maraThml, { verificador: SCHAFF_THML })).toThrow(
      /divisao_secao/,
    );
  });
});
