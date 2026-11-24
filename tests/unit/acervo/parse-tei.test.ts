import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ErroTei, parsearTei } from "../../../scripts/ingest/acervo-parse-tei";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const xml = readFileSync(path.join(FIXTURES, "perseus-josefo-trecho.xml"), "utf8");

const TEI = (corpo: string) =>
  `<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader/><text><body><div type="translation">${corpo}</div></body></text></TEI>`;

describe("parsearTei: recorte real do Perseus (Josefo, Whiston)", () => {
  const r = parsearTei(xml);
  const todos = r.secoes.flatMap((s) => s.paragrafos);
  const ref = (x: string) => todos.find((p) => p.ref === x);

  it("lê as duas seções (livros 18 e 20) com título e ordem da numeração da obra", () => {
    expect(r.secoes.map((s) => [s.slug, s.titulo, s.ordem])).toEqual([
      ["18", "Book 18", 18],
      ["20", "Book 20", 20],
    ]);
  });

  it("18.63 tem o texto de Whiston e a faixa 63 a 64", () => {
    const p = ref("18.63");
    expect(p?.texto).toContain("wise man");
    expect(p?.texto.startsWith("Now there was about this time Jesus")).toBe(true);
    expect([p?.ref_inicio, p?.ref_fim]).toEqual([63, 64]);
    expect(p?.texto).not.toContain("\n");
  });

  it("20.197 guarda a faixa 197 a 203 e contém 'brother of Jesus'", () => {
    const p = ref("20.197");
    expect(p?.texto).toContain("brother of Jesus");
    expect([p?.ref_inicio, p?.ref_fim]).toEqual([197, 203]);
  });

  it("as notas de editor ficam fora do texto e voltam à parte", () => {
    const p = ref("20.197");
    expect(p?.texto).not.toContain("It hence evidently appears");
    expect(p?.texto).not.toContain("Reland");
    expect(p?.texto).not.toContain("Primitive Christianity Revived");
    expect(r.notas.some((n) => n.startsWith("It hence evidently appears"))).toBe(true);
    for (const nota of r.notas) for (const x of todos) expect(x.texto).not.toContain(nota);
    // a frase continua inteira onde a nota foi retirada
    expect(p?.texto).toContain("was also of the sect of the Sadducees, who are very rigid");
  });
});

describe("parsearTei: casos sintéticos", () => {
  it("a última seção do livro fica sem faixa; seção seguinte define o fim da anterior", () => {
    const r = parsearTei(
      TEI(
        `<div subtype="book" n="1"><head>Book I</head>` +
          `<div subtype="section" n="1"><p>um</p></div>` +
          `<div subtype="section" n="5"><p>dois</p></div></div>`,
      ),
    );
    const [a, b] = r.secoes[0]?.paragrafos ?? [];
    expect([a?.ref, a?.ref_inicio, a?.ref_fim]).toEqual(["1.1", 1, 4]);
    expect([b?.ref, b?.ref_inicio, b?.ref_fim]).toEqual(["1.5", null, null]);
  });

  it("q vira aspas curvas, nota aninhada em q some, head e cabeçalho não entram", () => {
    const r = parsearTei(
      TEI(
        `<div subtype="book" n="2"><head>Titulo do livro</head><div subtype="section" n="1">` +
          `<head>Cabeca</head><p>Ele disse,<q rend="double">venha<note>comentario longo do editor que nao pertence</note> agora</q> e foi.</p></div></div>`,
      ),
    );
    expect(r.secoes[0]?.paragrafos[0]?.texto).toBe("Ele disse, “venha agora” e foi.");
    expect(r.notas).toEqual(["comentario longo do editor que nao pertence"]);
  });

  it("vários p na mesma unidade viram um só parágrafo, unidos por espaço", () => {
    const r = parsearTei(
      TEI(
        `<div subtype="book" n="1"><div subtype="section" n="9"><p>primeiro</p><p>segundo</p></div></div>`,
      ),
    );
    expect(r.secoes[0]?.paragrafos[0]?.texto).toBe("primeiro segundo");
  });

  it("entidade predefinida é decodificada; DOCTYPE e ENTITY são recusados", () => {
    const ok = parsearTei(
      TEI(`<div subtype="book" n="1"><div subtype="section" n="1"><p>a &amp; b</p></div></div>`),
    );
    expect(ok.secoes[0]?.paragrafos[0]?.texto).toBe("a & b");
    const mau = `<!DOCTYPE TEI [<!ENTITY x SYSTEM "file:///etc/passwd">]>${TEI("")}`;
    expect(() => parsearTei(mau)).toThrow(ErroTei);
  });

  it("entrada acima do teto é recusada; sem livro é recusada", () => {
    expect(() => parsearTei(xml, { maxBytes: 1000 })).toThrow(/teto/);
    expect(() => parsearTei(TEI("<p>solto</p>"))).toThrow(ErroTei);
  });

  it("é determinístico", () => {
    expect(JSON.stringify(parsearTei(xml))).toBe(JSON.stringify(parsearTei(xml)));
  });
});

describe("parsearTei: numeração fora de ordem na origem", () => {
  it("unidade fora de ordem e a anterior ficam sem faixa; as demais mantêm", () => {
    const sec = (n: string) => `<div subtype="section" n="${n}"><p>t${n}</p></div>`;
    const r = parsearTei(
      TEI(
        `<div subtype="book" n="17">${["320", "332", "13", "342", "345"].map(sec).join("")}</div>`,
      ),
    );
    const faixas = Object.fromEntries(
      (r.secoes[0]?.paragrafos ?? []).map((p) => [p.ref, [p.ref_inicio, p.ref_fim]]),
    );
    expect(faixas).toEqual({
      "17.320": [320, 331],
      "17.332": [null, null],
      "17.13": [null, null],
      "17.342": [342, 344],
      "17.345": [null, null],
    });
  });
});
