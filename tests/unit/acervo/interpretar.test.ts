import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpretarOrigem } from "../../../scripts/ingest/acervo-interpretar";
import { ErroLicenca } from "../../../scripts/ingest/acervo-licenca";

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
