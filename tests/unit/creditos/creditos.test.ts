import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { montarCreditos } from "@/modules/creditos/creditos";

// A página de créditos é gerada dos registros (ACER-12): toda entrada de cada registro aparece com
// autores, licença e versão, e o crédito literal da Bíblia Livre é idêntico ao do registro.

const registro = (arquivo: string) => parse(readFileSync(join("data", arquivo), "utf8"));
const datasets = registro("datasets.yaml") as Record<
  string,
  {
    nome: string;
    autores: string[];
    licenca: string;
    url_licenca: string;
    commit: string;
    data_versao: string;
    credito_literal?: string;
    alteracoes: string;
  }
>;
const tipografia = registro("tipografia.yaml") as {
  commit: string;
  fontes: { familia: string; autores: string; licenca: string; alteracoes: string }[];
};
const proprios = registro("creditos-proprios.yaml") as {
  licencas: Record<string, string>;
  entradas: {
    nome: string;
    autores: string[];
    licenca: string;
    versao: string;
    alteracoes: string;
  }[];
};

const pastas: string[] = [];
afterEach(() => {
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

// Cópia dos três registros numa pasta temporária, para os testes que adulteram um deles.
function copiaDosRegistros(): string {
  const pasta = mkdtempSync(join(tmpdir(), "jnf-creditos-"));
  pastas.push(pasta);
  for (const a of ["datasets.yaml", "tipografia.yaml", "creditos-proprios.yaml"]) {
    cpSync(join("data", a), join(pasta, a));
  }
  return pasta;
}

describe("montarCreditos", () => {
  const entradas = montarCreditos();
  const porNome = (nome: string) => entradas.find((e) => e.nome === nome);

  it("lista as cinco entradas da Fase 1, na ordem do contrato", () => {
    expect(entradas.map((e) => e.nome)).toEqual([
      "Bíblia Livre (BLIVRE)",
      "Conteúdo dos Estudos",
      "Código",
      "EB Garamond",
      "Cormorant Garamond",
    ]);
  });

  it("toda entrada de datasets.yaml aparece com autores, licença, versão e alterações do registro", () => {
    for (const d of Object.values(datasets)) {
      const e = porNome(d.nome);
      expect(e, d.nome).toBeDefined();
      for (const autor of d.autores) expect(e?.autores).toContain(autor);
      expect(e?.licenca).toBe(d.licenca);
      expect(e?.urlLicenca).toBe(d.url_licenca);
      expect(e?.versao).toContain(d.commit.slice(0, 7));
      expect(e?.versao).toContain(d.data_versao.split("-").reverse().join("/"));
      expect(e?.alteracoes).toBe(d.alteracoes);
    }
  });

  it("o crédito literal da Bíblia Livre é idêntico ao do registro", () => {
    const d = Object.values(datasets).find((x) => x.credito_literal);
    expect(d?.credito_literal).toBeTruthy();
    expect(porNome(d?.nome ?? "")?.creditoLiteral).toBe(d?.credito_literal);
    // O texto cita fonte e autores: nenhum pedaço da atribuição ficou de fora.
    expect(porNome(d?.nome ?? "")?.creditoLiteral).toContain("Diego Santos");
    expect(porNome(d?.nome ?? "")?.creditoLiteral).toContain(
      "Creative Commons Atribuição 3.0 Brasil",
    );
  });

  it("toda fonte de tipografia.yaml aparece com autores, licença, versão e alterações do registro", () => {
    for (const f of tipografia.fontes) {
      const e = porNome(f.familia);
      expect(e, f.familia).toBeDefined();
      expect(e?.autores).toBe(f.autores);
      expect(e?.licenca).toBe(f.licenca);
      expect(e?.urlLicenca).toBe(proprios.licencas[f.licenca]);
      expect(e?.versao).toContain(tipografia.commit.slice(0, 7));
      expect(e?.alteracoes).toBe(f.alteracoes);
    }
  });

  it("toda entrada de creditos-proprios.yaml aparece com autores, licença, versão e alterações", () => {
    for (const p of proprios.entradas) {
      const e = porNome(p.nome);
      expect(e, p.nome).toBeDefined();
      for (const autor of p.autores) expect(e?.autores).toContain(autor);
      expect(e?.licenca).toBe(p.licenca);
      expect(e?.versao).toBe(p.versao);
      expect(e?.alteracoes).toBe(p.alteracoes);
    }
    // O conteúdo (CC BY-SA 4.0) e o código (MIT) batem com os arquivos de licença do repositório.
    expect(readFileSync("content/LICENSE", "utf8")).toContain(
      "Attribution-ShareAlike 4.0 International",
    );
    expect(porNome("Conteúdo dos Estudos")?.licenca).toBe("CC BY-SA 4.0");
    expect(readFileSync("LICENSE", "utf8")).toMatch(/^MIT License/);
    expect(porNome("Código")?.licenca).toBe("MIT");
  });

  it("nenhuma entrada sai com campo vazio", () => {
    for (const e of entradas) {
      for (const campo of [e.nome, e.autores, e.licenca, e.versao, e.alteracoes]) {
        expect(campo.trim().length, e.nome).toBeGreaterThan(0);
      }
    }
  });
});

describe("a página nasce dos registros", () => {
  it("uma entrada nova num registro aparece sem mexer em código (controle contra texto escrito à mão)", () => {
    const pasta = copiaDosRegistros();
    const arquivo = join(pasta, "creditos-proprios.yaml");
    writeFileSync(
      arquivo,
      `${readFileSync(arquivo, "utf8")}  - nome: Entrada de teste\n    autores: [Alguém]\n    licenca: MIT\n    versao: "1"\n    alteracoes: Nenhuma.\n`,
    );
    const nomes = montarCreditos({ diretorio: pasta }).map((e) => e.nome);
    expect(nomes).toContain("Entrada de teste");
    expect(nomes).toHaveLength(6);
  });

  it("um conjunto novo em datasets.yaml aparece com o crédito dele", () => {
    const pasta = copiaDosRegistros();
    const arquivo = join(pasta, "datasets.yaml");
    writeFileSync(
      arquivo,
      `${readFileSync(arquivo, "utf8")}
outro-conjunto:
  nome: Outro Conjunto
  autores: [Fulana, Beltrano]
  licenca: CC BY 4.0
  url_licenca: https://creativecommons.org/licenses/by/4.0/
  fonte: https://example.test/outro
  commit: 0123456789abcdef
  data_versao: "2026-01-02"
  alteracoes: Nenhuma.
`,
    );
    const e = montarCreditos({ diretorio: pasta }).find((x) => x.nome === "Outro Conjunto");
    expect(e?.autores).toBe("Fulana e Beltrano");
    expect(e?.versao).toContain("0123456");
    expect(e?.versao).toContain("02/01/2026");
  });

  it("registro com campo faltando derruba a geração, em vez de cortar a atribuição", () => {
    const pasta = copiaDosRegistros();
    const arquivo = join(pasta, "datasets.yaml");
    writeFileSync(arquivo, readFileSync(arquivo, "utf8").replace(/^ {2}licenca: .*$/m, ""));
    expect(() => montarCreditos({ diretorio: pasta })).toThrow();
  });
});
