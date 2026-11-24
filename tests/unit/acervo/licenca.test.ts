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
