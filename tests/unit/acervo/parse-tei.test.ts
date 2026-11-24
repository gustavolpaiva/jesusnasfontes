import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ELEMENTOS_BLOCO,
  ELEMENTOS_DESCARTADOS,
  ELEMENTOS_ESTRUTURA,
  ELEMENTOS_TEXTO,
  ErroTei,
  parsearTei,
} from "../../../scripts/ingest/acervo-parse-tei";

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

describe("parsearTei: Tácito (livro e capítulo) e Luciano (obra curta, sem livro)", () => {
  const tacito = parsearTei(readFileSync(path.join(FIXTURES, "perseus-tacito-trecho.xml"), "utf8"));
  const luciano = parsearTei(
    readFileSync(path.join(FIXTURES, "perseus-luciano-eng4-trecho.xml"), "utf8"),
  );

  it("Tácito: o livro 15 vira seção e o capítulo vira parágrafo 15.44, sem texto de marcação", () => {
    expect(tacito.secoes.map((s) => [s.slug, s.titulo])).toEqual([["15", "Book 15"]]);
    const p = tacito.secoes[0]?.paragrafos.find((x) => x.ref === "15.44");
    expect(p?.texto).toContain("Christus");
    expect(p?.texto).toContain("Pontius Pilatus");
    expect(p?.texto).toContain("called Christians by the populace");
    expect(p?.texto).not.toMatch(/[<>]/);
    expect(p?.texto).not.toContain("BOOK XV");
    expect(tacito.secoes[0]?.paragrafos.map((x) => x.ref)).toEqual(["15.43", "15.44", "15.45"]);
  });

  it("Luciano: sem livro, uma só seção 'texto' e a referência é o próprio número da seção", () => {
    expect(luciano.secoes).toHaveLength(1);
    expect(luciano.secoes[0]?.slug).toBe("texto");
    expect(luciano.secoes[0]?.ordem).toBe(1);
    expect(luciano.secoes[0]?.paragrafos.map((x) => x.ref)).toEqual(["11", "12", "13"]);
    const p13 = luciano.secoes[0]?.paragrafos.find((x) => x.ref === "13");
    expect(p13?.texto).toContain("assistance, and legal advice");
    // O marcador de página no meio do parágrafo não deixa rastro nem quebra a frase.
    expect(p13?.texto).not.toContain("v.4.p.83");
    expect(luciano.secoes[0]?.paragrafos[0]?.texto).toContain("crucified");
  });

  it("verso (l) dentro de p entra no texto; lacuna (gap) entra como o sinal da própria edição", () => {
    const r = parsearTei(
      TEI(
        `<div subtype="book" n="1"><div subtype="section" n="1"><p>citou:\n<l>um</l>\n<l>dois</l></p>` +
          `</div><div subtype="section" n="2"><p><gap reason="lost" rend=" . . . "/>depois</p></div></div>`,
      ),
    );
    expect(r.secoes[0]?.paragrafos.map((p) => p.texto)).toEqual(["citou: um dois", ". . . depois"]);
  });

  it("seção solta depois de um livro explícito é recusada (estrutura mista)", () => {
    expect(() =>
      parsearTei(
        TEI(
          `<div subtype="book" n="1"><div subtype="section" n="1"><p>a</p></div></div>` +
            `<div subtype="section" n="2"><p>solta</p></div>`,
        ),
      ),
    ).toThrow(ErroTei);
  });
});

describe("parsearTei: falha em voz alta (nada some em silêncio)", () => {
  const livro = (dentro: string) => TEI(`<div subtype="book" n="1">${dentro}</div>`);
  const secao = (dentro: string) => livro(`<div subtype="section" n="1">${dentro}</div>`);

  it("elemento sem regra dentro do parágrafo reprova com o nome, a unidade e a linha", () => {
    const xml = secao("<p>um</p>\n<p>dois <verse>versos</verse></p>");
    let erro: Error | undefined;
    try {
      parsearTei(xml);
    } catch (e) {
      erro = e as Error;
    }
    expect(erro).toBeInstanceOf(ErroTei);
    expect(erro?.message).toContain("<verse>");
    expect(erro?.message).toContain("unidade 1.1");
    expect(erro?.message).toContain("linha 2");
  });

  it("elemento sem regra fora do parágrafo reprova (o que a lista não conhece, não passa)", () => {
    expect(() => parsearTei(secao("<p>um</p><table><row/></table>"))).toThrow(/<table>/);
    expect(() => parsearTei(secao("<p>um</p><argument>resumo</argument>"))).toThrow(/<argument>/);
  });

  it("texto fora de parágrafo reprova; parágrafo fora de unidade reprova", () => {
    expect(() => parsearTei(secao("<p>um</p>solto"))).toThrow(/texto fora de parágrafo/);
    expect(() => parsearTei(livro("<p>sem unidade</p>"))).toThrow(/<p> fora de uma unidade/);
  });

  it("controles positivos: inline mantém o texto; nota, cabeçalho e autor ficam fora; marcas vazias não deixam rastro", () => {
    const r = parsearTei(
      secao(
        '<head>Título<date>1</date></head><docAuthor>Autor</docAuthor><milestone unit="x"/>' +
          '<p>a <emph>b</emph> <name type="person">c</name> <placeName>d</placeName> <rs type="placename">e</rs> ' +
          "<soCalled>f</soCalled> <gloss>g</gloss> <foreign>h</foreign> <term>i</term> " +
          '<quote><p>j</p></quote><pb n="3"/><note>apparatus <emph>x</emph></note> fim</p>',
      ),
    );
    expect(r.secoes[0]?.paragrafos.map((q) => q.texto)).toEqual(["a b c d e f g h i j fim"]);
    expect(r.notas).toEqual(["apparatus x"]);
  });

  it("as listas do parser não se cruzam: cada elemento tem UMA regra", () => {
    const todas = [
      ...ELEMENTOS_ESTRUTURA,
      ...ELEMENTOS_BLOCO,
      ...ELEMENTOS_TEXTO,
      ...ELEMENTOS_DESCARTADOS,
    ];
    expect(new Set(todas).size).toBe(todas.length);
  });
});
