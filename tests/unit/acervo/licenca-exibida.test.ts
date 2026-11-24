import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODIGOS_FIXOS_DE_LICENCA,
  licencaCitaATraducao,
  licencaValida,
  textoDaLicenca,
} from "../../../src/modules/acervo/licenca-exibida";
import { ErroContrato, interpretarFonteYaml } from "../../../src/modules/acervo/schemas";

// O texto de licença na tela é jurídico: vem de um vocabulário fechado, nunca da redação de quem preenche o
// YAML. Código fora do vocabulário é recusado no contrato, com o NOME do campo.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const yamlBase = () =>
  readFileSync(path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"), "utf8");
const comLicenca = (codigo: string) => yamlBase().replace(/^licenca: .*$/m, `licenca: ${codigo}`);

const WHISTON = { tradutor: "William Whiston", ano: 1737 };

describe("textoDaLicenca: cada código do vocabulário vira o texto do contrato de copy", () => {
  it("dp-anterior-1929", () => {
    expect(textoDaLicenca("dp-anterior-1929", { ano: 1737 })).toBe(
      "Domínio público (tradução anterior a 1929)",
    );
  });

  it("dp-dedicado", () => {
    expect(textoDaLicenca("dp-dedicado", {})).toBe("Domínio público, dedicado pelo tradutor");
  });

  it("dp-declarado-pela-origem", () => {
    expect(textoDaLicenca("dp-declarado-pela-origem", {})).toBe(
      "Domínio público, como declara a origem",
    );
  });

  it("edicao-digital-cc-by-sa-e-traducao-dp traz o tradutor e o ano", () => {
    expect(textoDaLicenca("edicao-digital-cc-by-sa-e-traducao-dp", WHISTON)).toBe(
      "Edição digital: CC BY-SA. Tradução de William Whiston, 1737: domínio público.",
    );
  });

  it("edicao-digital-cc-by-sa-4-e-traducao-dp usa CC BY-SA 4.0", () => {
    expect(textoDaLicenca("edicao-digital-cc-by-sa-4-e-traducao-dp", WHISTON)).toBe(
      "Edição digital: CC BY-SA 4.0. Tradução de William Whiston, 1737: domínio público.",
    );
  });

  it("aberta-<código> mostra o código da licença aberta", () => {
    expect(textoDaLicenca("aberta-cc-by-4.0", {})).toBe("CC BY 4.0");
    expect(textoDaLicenca("aberta-cc0-1.0", {})).toBe("CC0 1.0");
  });

  it("só as licenças que citam a tradução dispensam a linha de tradutor do crédito", () => {
    expect(licencaCitaATraducao("edicao-digital-cc-by-sa-e-traducao-dp")).toBe(true);
    expect(licencaCitaATraducao("edicao-digital-cc-by-sa-4-e-traducao-dp")).toBe(true);
    expect(licencaCitaATraducao("dp-dedicado")).toBe(false);
    expect(licencaCitaATraducao("aberta-cc-by-4.0")).toBe(false);
  });

  it("código fora do vocabulário aparece como está, nunca some", () => {
    expect(textoDaLicenca("licenca-que-ninguem-conhece", {})).toBe("licenca-que-ninguem-conhece");
  });
});

describe("licencaValida", () => {
  it("aceita todo código fixo e as licenças abertas bem formadas", () => {
    for (const c of CODIGOS_FIXOS_DE_LICENCA) expect(licencaValida(c)).toBe(true);
    expect(licencaValida("aberta-cc-by-4.0")).toBe(true);
  });

  it("recusa o que não é do vocabulário (os códigos antigos incluídos)", () => {
    for (const c of [
      "dominio-publico",
      "cc-by-sa-4.0",
      "aberta-",
      "aberta-CC BY",
      "Domínio público",
      "",
    ])
      expect(licencaValida(c)).toBe(false);
  });
});

describe("contrato do YAML de Fonte: o campo licenca fecha no vocabulário", () => {
  it("aceita o código do vocabulário", () => {
    const f = interpretarFonteYaml(comLicenca("edicao-digital-cc-by-sa-e-traducao-dp"), "f.yaml");
    expect(f.licenca).toBe("edicao-digital-cc-by-sa-e-traducao-dp");
  });

  it("recusa código fora do vocabulário com o nome do campo", () => {
    let mensagem = "";
    try {
      interpretarFonteYaml(comLicenca("cc-by-sa-4.0"), "f.yaml");
    } catch (erro) {
      expect(erro).toBeInstanceOf(ErroContrato);
      mensagem = (erro as Error).message;
    }
    expect(mensagem).toContain("licenca");
  });

  it("licença que cita a tradução exige tradutor e ano no mesmo YAML", () => {
    const semTradutor = comLicenca("edicao-digital-cc-by-sa-e-traducao-dp").replace(
      /^tradutor: .*$/m,
      "",
    );
    expect(() => interpretarFonteYaml(semTradutor, "f.yaml")).toThrow(/tradutor/);
    const semAno = comLicenca("edicao-digital-cc-by-sa-e-traducao-dp").replace(
      /^traducao_ano: .*$/m,
      "",
    );
    expect(() => interpretarFonteYaml(semAno, "f.yaml")).toThrow(/traducao_ano/);
  });
});
