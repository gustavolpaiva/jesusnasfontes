import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErroThml, parsearThml } from "../../../scripts/ingest/acervo-parse-thml";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const mara = readFileSync(path.join(FIXTURES, "ccel-anf08-mara.xml"), "utf8");
const notas = readFileSync(path.join(FIXTURES, "ccel-anf01-notas.xml"), "utf8");
const lightfoot = readFileSync(path.join(FIXTURES, "ccel-lightfoot-trecho.xml"), "utf8");

describe("parsearThml: recorte real do ANF 8 (carta de Mara bar Serapião, div2 ix.xvii)", () => {
  const r = parsearThml(mara, { divisaoSecao: "div2" });
  const todos = r.secoes.flatMap((s) => s.paragrafos);
  const ref = (x: string) => todos.find((p) => p.ref === x);

  it("a divisão ix.xvii vira UMA seção, com o id estável da própria edição e o título do arquivo", () => {
    expect(r.secoes).toHaveLength(1);
    const s = r.secoes[0];
    expect(s?.slug).toBe("ix-xvii");
    expect(s?.titulo).toBe("A Letter of Mara, Son of Serapion.");
    expect(s?.ordem).toBe(1);
  });

  it("lê os 33 parágrafos da carta; o id do parágrafo carrega o id da divisão da edição", () => {
    expect(todos).toHaveLength(33);
    for (const p of todos) expect(p.ref.startsWith("ix.xvii-")).toBe(true);
    // os ids pulam os parágrafos das notas (p4, p7… são <p class="endnote"> dentro de <note>)
    expect(ref("ix.xvii-p4")).toBeUndefined();
    expect(ref("ix.xvii-p5")?.texto).toBe("Mara, son of Serapion, to Serapion, my son: peace.");
    expect(ref("ix.xvii-p65")?.texto).toContain("endeth the letter of Mara, son of Serapion");
  });

  it("o texto NÃO contém o conteúdo de nenhuma das 32 notas de editor; as notas voltam à parte", () => {
    expect(r.notas).toHaveLength(32);
    expect(r.notas.some((n) => n.includes("Dr. Payne Smith"))).toBe(true);
    expect(r.notas.some((n) => n.includes("good conscience"))).toBe(true);
    for (const p of todos) {
      expect(p.texto).not.toContain("Payne Smith");
      expect(p.texto).not.toContain("good conscience");
      expect(p.texto).not.toContain("Græcism");
      expect(p.texto).not.toContain("<note");
    }
  });

  it("mantém o <pb> como metadado de página da edição impressa, fora do texto", () => {
    expect(ref("ix.xvii-p1")?.paginas).toEqual(["735"]);
    for (const p of todos) expect(p.texto).not.toContain("Page_735");
    expect(ref("ix.xvii-p1")?.texto).toBe("Ancient Syriac Documents.");
  });

  it("o parágrafo ix.xvii-p6 tem o texto da carta sem a nota que o interrompe", () => {
    const p = ref("ix.xvii-p6");
    expect(p?.texto).toContain("hadst begun in good earnest");
    expect(p?.texto).toContain("has shown no eagerness to continue.");
  });
});

describe("parsearThml: recorte real do ANF 1 com nota dentro do parágrafo (1ª Apologia de Justino, cap. XLVI)", () => {
  const r = parsearThml(notas, { divisaoSecao: "div2" });

  it("a divisão viii.ii vira seção e o capítulo é parágrafo viii.ii.xlvi-p1", () => {
    expect(r.secoes).toHaveLength(1);
    expect(r.secoes[0]?.slug).toBe("viii-ii");
    expect(r.secoes[0]?.titulo).toBe("The First Apology");
    const p = r.secoes[0]?.paragrafos.find((x) => x.ref === "viii.ii.xlvi-p1");
    expect(p?.texto).toContain("Pontius Pilate");
    // a nota interrompe a frase; sem ela, o texto corre íntegro
    expect(p?.texto).toContain(
      "lived reasonably are Christians, even though they have been thought atheists",
    );
  });

  it("a nota longa (com grego e scripRef) fica fora do texto e volta à parte", () => {
    const p = r.secoes[0]?.paragrafos.find((x) => x.ref === "viii.ii.xlvi-p1");
    expect(p?.texto).not.toContain("eccentric but thoughtful Ed. King");
    expect(p?.texto).not.toContain("μετὰ λόγου");
    expect(r.notas.some((n) => n.includes("eccentric but thoughtful Ed. King"))).toBe(true);
  });

  it("tirar as notas do arquivo não muda o texto lido: as notas nunca eram do texto", () => {
    // cirurgia de teste sobre a fixture (o código do pipeline não usa regex sobre XML)
    const semNotas = notas.replace(/<note\b[\s\S]*?<\/note>/g, "");
    expect(semNotas).not.toBe(notas);
    const r2 = parsearThml(semNotas, { divisaoSecao: "div2" });
    expect(r2.secoes[0]?.paragrafos).toEqual(r.secoes[0]?.paragrafos);
    expect(r2.notas).toEqual([]);
  });

  it("o cabeçalho de capítulo (h3) não entra no texto", () => {
    for (const p of r.secoes[0]?.paragrafos ?? []) expect(p.texto).not.toContain("Chapter XLVI");
  });
});

describe("parsearThml: recorte real de Lightfoot (Inácio aos Efésios, div2 por carta)", () => {
  const r = parsearThml(lightfoot, { divisaoSecao: "div2" });

  it("DOCTYPE com DTD EXTERNA e sem subconjunto interno é aceito (o parser nunca resolve DTD)", () => {
    expect(lightfoot).toContain("<!DOCTYPE ThML PUBLIC");
    expect(r.secoes).toHaveLength(1);
  });

  it("a carta vira a seção ii.iii com o título do arquivo e os parágrafos p1 a p3", () => {
    const s = r.secoes[0];
    expect(s?.slug).toBe("ii-iii");
    expect(s?.titulo).toBe("The Epistle of Ignatius to the Ephesians");
    expect(s?.paragrafos.map((p) => p.ref)).toEqual(["ii.iii-p1", "ii.iii-p2", "ii.iii-p3"]);
    expect(s?.paragrafos[0]?.texto.startsWith("Ignatius, who is also Theophorus")).toBe(true);
    // <br /><br /> vira espaço, não quebra
    expect(s?.paragrafos[0]?.texto).not.toContain("<br");
  });

  it("os cabeçalhos h2 da carta não entram no texto", () => {
    for (const p of r.secoes[0]?.paragrafos ?? []) {
      expect(p.texto).not.toContain("THE EPISTLE OF IGNATIUS");
      expect(p.texto).not.toContain("IgnEph.");
    }
  });
});

describe("parsearThml: defesa da entrada (dado de terceiros não confiável)", () => {
  const MIN =
    '<ThML><ThML.head></ThML.head><ThML.body><div1 id="i" title="t"><div2 id="i.i" title="u"><p id="i.i-p1">texto</p></div2></div1></ThML.body></ThML>';

  it("DOCTYPE com subconjunto interno é recusado", () => {
    const interno = `<!DOCTYPE ThML [ <!-- comentario qualquer --> ]>\n${MIN}`;
    expect(() => parsearThml(interno, { divisaoSecao: "div2" })).toThrow(ErroThml);
    expect(() => parsearThml(interno, { divisaoSecao: "div2" })).toThrow(/subconjunto interno/);
  });

  it("ENTITY é recusado", () => {
    expect(() =>
      parsearThml(`<!DOCTYPE ThML [ <!ENTITY x "y"> ]>\n${MIN}`, { divisaoSecao: "div2" }),
    ).toThrow(/ENTITY/);
  });

  it("entrada acima do teto é recusada", () => {
    expect(() => parsearThml(MIN, { divisaoSecao: "div2", maxBytes: 10 })).toThrow(/teto/);
  });

  it("divisão no nível da seção sem id é erro: o id estável é obrigatório", () => {
    const semId = MIN.replace('<div2 id="i.i" title="u">', '<div2 title="u">');
    expect(() => parsearThml(semId, { divisaoSecao: "div2" })).toThrow(ErroThml);
  });

  it("duas divisões com o mesmo id são erro", () => {
    const duplicado = MIN.replace(
      "</div2>",
      '</div2><div2 id="i.i" title="repetida"><p id="i.i-p9">outro</p></div2>',
    );
    expect(() => parsearThml(duplicado, { divisaoSecao: "div2" })).toThrow(/repetid/);
  });

  it("divisão do nível da seção aninhada em outra do mesmo nível é erro", () => {
    const aninhado = MIN.replace(
      '<p id="i.i-p1">texto</p>',
      '<p id="i.i-p1">texto</p><div2 id="i.ii" title="dentro"><p id="i.ii-p1">x</p></div2>',
    );
    expect(() => parsearThml(aninhado, { divisaoSecao: "div2" })).toThrow(ErroThml);
  });

  it("nenhuma divisão no nível configurado é erro", () => {
    expect(() => parsearThml(MIN, { divisaoSecao: "div3" })).toThrow(ErroThml);
  });

  it("divisão sem parágrafo é pulada e relatada, não vira seção vazia", () => {
    const comVazia = MIN.replace(
      "</div2>",
      '</div2><div2 id="i.tab" title="Synoptical Table"><table><row><cell>x</cell></row></table></div2>',
    );
    const r = parsearThml(comVazia, { divisaoSecao: "div2" });
    expect(r.secoes).toHaveLength(1);
    expect(r.divisoesSemParagrafo).toEqual(["i.tab"]);
  });

  it("parágrafo sem id (os índices do CCEL) não entra no texto: é pulado e contado", () => {
    const comIndice = MIN.replace(
      "</div2>",
      '</div2><div2 id="i.ind" title="Index"><p class="bbook">Genesis</p></div2>',
    );
    const r = parsearThml(comIndice, { divisaoSecao: "div2" });
    expect(r.secoes).toHaveLength(1);
    expect(r.divisoesSemParagrafo).toEqual(["i.ind"]);
    expect(r.paragrafosSemId).toBe(1);
    expect(r.secoes[0]?.paragrafos.map((p) => p.texto)).toEqual(["texto"]);
  });

  it("blocos ThML.head no meio do corpo (metadado por obra do CCEL) não entram no texto", () => {
    const comHead = MIN.replace(
      '<div2 id="i.i" title="u">',
      '<ThML.head><electronicEdInfo><DC><DC.Title>Obra</DC.Title></DC></electronicEdInfo></ThML.head><div2 id="i.i" title="u">',
    );
    const r = parsearThml(comHead, { divisaoSecao: "div2" });
    expect(r.secoes[0]?.paragrafos.map((p) => p.texto)).toEqual(["texto"]);
  });
});
