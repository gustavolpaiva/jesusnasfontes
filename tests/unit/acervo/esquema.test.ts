import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ErroContrato,
  interpretarDerivado,
  interpretarFonteYaml,
} from "../../../src/modules/acervo/schemas";

// Contrato do derivado (o texto já interpretado de uma Fonte) e do YAML de Fonte: o que faltar ou vier
// fora da lista é recusado com o NOME do campo, nunca com texto da Fonte.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const lerDerivadoBruto = () =>
  JSON.parse(readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"));
const lerYamlBruto = () =>
  readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8");

function mensagemDe(f: () => unknown): string {
  try {
    f();
  } catch (erro) {
    expect(erro).toBeInstanceOf(ErroContrato);
    return (erro as Error).message;
  }
  throw new Error("esperava ErroContrato, mas nada foi lançado");
}

describe("contrato do derivado", () => {
  it("aceita o recorte real do Josefo", () => {
    const d = interpretarDerivado(lerDerivadoBruto(), "josefo-antiguidades");
    expect(d.slug).toBe("josefo-antiguidades");
    expect(d.secoes.map((s) => s.slug)).toEqual(["18", "20"]);
    expect(d.secoes[1]?.paragrafos[0]).toMatchObject({
      ref: "20.197",
      ref_inicio: 197,
      ref_fim: 203,
    });
  });

  it("recusa campo faltando, com o nome do campo", () => {
    for (const campo of [
      "versao_formato",
      "slug",
      "idioma",
      "origem_id",
      "origem_sha256",
      "gerado_por",
    ]) {
      const bruto = lerDerivadoBruto();
      delete bruto[campo];
      expect(mensagemDe(() => interpretarDerivado(bruto, "x"))).toContain(campo);
    }
  });

  it("recusa seção sem parágrafo, apontando o caminho", () => {
    const bruto = lerDerivadoBruto();
    bruto.secoes[0].paragrafos = [];
    expect(mensagemDe(() => interpretarDerivado(bruto, "x"))).toContain("secoes.0.paragrafos");
  });

  it("recusa texto vazio ou só de espaços", () => {
    for (const vazio of ["", "   \n "]) {
      const bruto = lerDerivadoBruto();
      bruto.secoes[1].paragrafos[0].texto = vazio;
      expect(mensagemDe(() => interpretarDerivado(bruto, "x"))).toContain(
        "secoes.1.paragrafos.0.texto",
      );
    }
  });

  it("recusa campo desconhecido (nada passa calado)", () => {
    const bruto = lerDerivadoBruto();
    bruto.secoes[0].paragrafos[0].notas = ["nota de editor"];
    expect(mensagemDe(() => interpretarDerivado(bruto, "x"))).toContain("notas");
  });

  it("recusa a mesma referência em dois parágrafos e faixa invertida", () => {
    const repetida = lerDerivadoBruto();
    repetida.secoes[1].paragrafos[0].ref = "18.63";
    expect(mensagemDe(() => interpretarDerivado(repetida, "x"))).toContain("18.63");

    const invertida = lerDerivadoBruto();
    invertida.secoes[1].paragrafos[0].ref_fim = 100;
    expect(mensagemDe(() => interpretarDerivado(invertida, "x"))).toContain("ref_fim");
  });

  it("recusa sha256 de origem fora do formato e slug que não é kebab-case", () => {
    const sha = lerDerivadoBruto();
    sha.origem_sha256 = "abc";
    expect(mensagemDe(() => interpretarDerivado(sha, "x"))).toContain("origem_sha256");
    const slug = lerDerivadoBruto();
    slug.slug = "Josefo_Antiguidades";
    expect(mensagemDe(() => interpretarDerivado(slug, "x"))).toContain("slug");
  });

  it("a mensagem de erro nunca carrega o texto da Fonte", () => {
    const bruto = lerDerivadoBruto();
    bruto.secoes[0].ordem = "dezoito";
    const msg = mensagemDe(() => interpretarDerivado(bruto, "x"));
    expect(msg).not.toContain("wise man");
    expect(msg).not.toContain("dezoito");
  });
});

describe("contrato do YAML de Fonte", () => {
  it("aceita a fixture do Josefo", () => {
    const f = interpretarFonteYaml(lerYamlBruto(), "josefo-antiguidades.yaml");
    expect(f).toMatchObject({
      slug: "josefo-antiguidades",
      nivel: "primaria",
      tipo_texto: "integral",
      idioma: "en",
      publicada: true,
      traduzida_por_nos: false,
    });
    expect(f.secoes.map((s) => s.slug)).toEqual(["18", "20"]);
    expect(f.secoes[0]?.palavras_chave_pt).toEqual(["Jesus", "Pilatos", "cristãos"]);
  });

  it("recusa Nível fora da lista", () => {
    const yaml = lerYamlBruto().replace("nivel: primaria", "nivel: lenda");
    expect(mensagemDe(() => interpretarFonteYaml(yaml, "f.yaml"))).toContain("nivel");
  });

  it("recusa campo obrigatório ausente", () => {
    for (const campo of ["slug", "titulo", "nivel", "tipo_texto", "idioma", "publicada"]) {
      const yaml = lerYamlBruto()
        .split("\n")
        .filter((l) => !l.startsWith(`${campo}:`))
        .join("\n");
      expect(mensagemDe(() => interpretarFonteYaml(yaml, "f.yaml"))).toContain(campo);
    }
  });

  it("texto integral exige licença e endereço de origem em https", () => {
    const semLicenca = lerYamlBruto().replace(/^licenca: .*$/m, "");
    expect(mensagemDe(() => interpretarFonteYaml(semLicenca, "f.yaml"))).toContain("licenca");
    const http = lerYamlBruto().replace(
      "origem_url: https://www.perseus.tufts.edu/",
      "origem_url: http://www.perseus.tufts.edu/",
    );
    expect(mensagemDe(() => interpretarFonteYaml(http, "f.yaml"))).toContain("origem_url");
  });

  it("recusa seção repetida e campo desconhecido", () => {
    const repetida = lerYamlBruto().replace('slug: "20"', 'slug: "18"');
    expect(mensagemDe(() => interpretarFonteYaml(repetida, "f.yaml"))).toContain("secoes");
    const extra = `${lerYamlBruto()}\nvoce_nao_conhece_este_campo: sim\n`;
    expect(mensagemDe(() => interpretarFonteYaml(extra, "f.yaml"))).toContain(
      "voce_nao_conhece_este_campo",
    );
  });

  it("YAML ilegível vira erro de contrato, sem o conteúdo", () => {
    expect(mensagemDe(() => interpretarFonteYaml("a: [b", "f.yaml"))).toContain("f.yaml");
  });
});
