import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as lerYaml } from "yaml";

// Pitfall 5 da pesquisa: "Gospel of Thomas" é DOIS textos. O do ANF 8 (três formas grega e latina) é o
// Evangelho da INFÂNCIA de Tomé; o dos 114 ditos é o copta de Nag Hammadi, na tradução de Mattison (D-24).
// Este teste lê os dois YAML do repositório e barra a confusão para sempre: slugs distintos, títulos
// distintos e a origem de cada um nomeada.
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

type Tomé = {
  slug: string;
  titulo: string;
  origem_nome: string;
  origem_url: string;
  tradutor?: string;
  edicao: string;
  secoes: { slug: string; titulo: string }[];
};

function ler(slug: string): Tomé {
  const caminho = path.join(RAIZ, "content", "acervo", "fontes", `${slug}.yaml`);
  return lerYaml(readFileSync(caminho, "utf8")) as Tomé;
}

describe("os dois Evangelhos de Tomé nunca se confundem", () => {
  const copta = ler("evangelho-de-tome");
  const infancia = ler("evangelho-da-infancia-de-tome");

  it("têm slugs distintos", () => {
    expect(copta.slug).toBe("evangelho-de-tome");
    expect(infancia.slug).toBe("evangelho-da-infancia-de-tome");
    expect(copta.slug).not.toBe(infancia.slug);
  });

  it("têm títulos distintos e exatos: Tomé e Infância de Tomé", () => {
    expect(copta.titulo).toBe("Evangelho de Tomé");
    expect(infancia.titulo).toBe("Evangelho da Infância de Tomé");
    expect(copta.titulo).not.toBe(infancia.titulo);
  });

  it("o dos 114 ditos vem da página do Mattison (gospels.net, D-24)", () => {
    expect(copta.origem_nome).toBe("gospels.net");
    expect(copta.origem_url).toBe("https://www.gospels.net/thomas");
    expect(copta.tradutor).toContain("Mattison");
    // os 114 ditos, numa só seção
    expect(copta.secoes).toHaveLength(1);
    expect(copta.secoes[0]?.slug).toBe("texto");
  });

  it("o da infância vem do ANF 8 (CCEL), com as três formas do volume", () => {
    expect(infancia.origem_nome).toBe("Christian Classics Ethereal Library");
    expect(infancia.origem_url).toBe("https://ccel.org/ccel/schaff/anf08");
    expect(infancia.edicao).toContain("Ante-Nicene Fathers, vol. 8");
    // as três formas que o volume traz (grega primeira, grega segunda e latina), não os 114 ditos
    expect(infancia.secoes.map((s) => s.slug)).toEqual(["vii-viii", "vii-ix", "vii-x"]);
    expect(infancia.secoes.every((s) => s.titulo.toLowerCase().includes("114"))).toBe(false);
  });

  it("nenhuma seção de um tem o slug de seção do outro", () => {
    const doCopta = new Set(copta.secoes.map((s) => s.slug));
    for (const s of infancia.secoes) expect(doCopta.has(s.slug)).toBe(false);
  });
});
