import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ErroLicenca,
  exigirTraducaoTei,
  lerCabecalhoTei,
} from "../../../scripts/ingest/acervo-licenca";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const xml = readFileSync(path.join(FIXTURES, "perseus-josefo-trecho.xml"), "utf8");
const WHISTON = { tradutores: ["William Whiston"], licenca: "CC BY-SA" };

describe("exigirTraducaoTei", () => {
  it("lê tradutor, licença e ano de edição do cabeçalho", () => {
    const c = lerCabecalhoTei(xml);
    expect(c.tradutores).toEqual(["William Whiston"]);
    expect(c.licenca).toContain("Creative Commons Attribution-ShareAlike (CC BY-SA)");
    expect(c.licencaUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(c.anos).toContain("1856");
  });

  it("controle positivo: o tradutor e a licença esperados passam", () => {
    expect(() => exigirTraducaoTei(xml, WHISTON)).not.toThrow();
  });

  it("controle negativo: outro tradutor esperado reprova (armadilha do Perseus)", () => {
    expect(() =>
      exigirTraducaoTei(xml, { tradutores: ["Austin Morris Harmon"], licenca: "CC BY-SA" }),
    ).toThrow(ErroLicenca);
  });

  it("controle negativo: cabeçalho com tradutor a mais reprova", () => {
    const outro = xml.replace(
      '<editor role="translator">William Whiston</editor>     \n        <sponsor>',
      '<editor role="translator">William Whiston</editor><editor role="translator">Austin Morris Harmon</editor><sponsor>',
    );
    expect(outro).not.toBe(xml);
    expect(() => exigirTraducaoTei(outro, WHISTON)).toThrow(/tradutor/);
  });

  it("licença diferente da esperada reprova", () => {
    expect(() => exigirTraducaoTei(xml, { ...WHISTON, licenca: "CC BY-NC" })).toThrow(ErroLicenca);
  });

  it("cabeçalho sem licença reprova; arquivo sem cabeçalho reprova", () => {
    const sem = xml.replace(/<licence[\s\S]*?<\/licence>/, "");
    expect(sem).not.toBe(xml);
    expect(() => exigirTraducaoTei(sem, WHISTON)).toThrow(/sem licença/);
    expect(() => exigirTraducaoTei("<TEI/>", WHISTON)).toThrow(ErroLicenca);
  });
});

const lucianoEng2 = readFileSync(path.join(FIXTURES, "perseus-luciano-eng2-cabecalho.xml"), "utf8");
const lucianoEng4 = readFileSync(path.join(FIXTURES, "perseus-luciano-eng4-trecho.xml"), "utf8");
const tacito = readFileSync(path.join(FIXTURES, "perseus-tacito-trecho.xml"), "utf8");
const FOWLER = {
  tradutores: ["Henry Watson Fowler", "Francis George Fowler"],
  licenca: "CC BY-SA",
};

describe("Luciano: o cabeçalho CC BY-SA não prova o direito da tradução (Pitfall 1, T-02-12)", () => {
  it("controle negativo: o perseus-eng2 real (Harmon, 1936) reprova e a mensagem cita o tradutor lido", () => {
    const c = lerCabecalhoTei(lucianoEng2);
    expect(c.tradutores).toEqual(["Austin Morris Harmon"]);
    expect(c.anos).toContain("1936");
    // O cabeçalho do arquivo protegido DIZ CC BY-SA: só o tradutor o denuncia.
    expect(c.licenca).toContain("CC BY-SA");
    expect(() => exigirTraducaoTei(lucianoEng2, FOWLER)).toThrow(ErroLicenca);
    expect(() => exigirTraducaoTei(lucianoEng2, FOWLER)).toThrow(/Austin Morris Harmon/);
  });

  it("controle positivo: o perseus-eng4 real (Fowler e Fowler, 1905) passa", () => {
    const c = exigirTraducaoTei(lucianoEng4, FOWLER);
    expect(c.tradutores).toEqual(["Francis George Fowler", "Henry Watson Fowler"]);
    expect(c.anos).toContain("1905");
  });

  it("o eng4 não passa se o registro esperasse só um dos dois tradutores", () => {
    expect(() =>
      exigirTraducaoTei(lucianoEng4, { tradutores: ["Henry Watson Fowler"], licenca: "CC BY-SA" }),
    ).toThrow(ErroLicenca);
  });
});

describe("Tácito: licença da edição digital e o aviso do editorialDecl sobre a reimpressão de 1942", () => {
  const TACITO = {
    tradutores: ["Alfred John Church", "William Jackson Brodribb"],
    licenca: "Attribution-ShareAlike 4.0",
  };

  it("lê CC BY-SA 4.0, os dois tradutores e os anos 1869 e 1942 do cabeçalho", () => {
    const c = exigirTraducaoTei(tacito, TACITO);
    expect(c.licencaUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(c.anos).toEqual(expect.arrayContaining(["1869", "1942"]));
  });

  it("registra o aviso do editorialDecl: o texto parece seguir a reimpressão de 1942", () => {
    const c = lerCabecalhoTei(tacito);
    expect(c.avisoEditorial).toContain("substantially based on the 1942 reprint");
  });

  it("cabeçalho sem editorialDecl devolve aviso vazio (Josefo)", () => {
    expect(lerCabecalhoTei(xml).avisoEditorial).toBe("");
  });

  it("tradutor trocado reprova também em Tácito", () => {
    expect(() => exigirTraducaoTei(tacito, { ...TACITO, tradutores: ["William Whiston"] })).toThrow(
      ErroLicenca,
    );
  });
});
