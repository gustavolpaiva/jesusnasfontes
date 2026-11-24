import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { caminhoDoBruto, PASTA_BRUTO } from "../../../scripts/ingest/acervo-origens";
import {
  ELEMENTOS_BLOCO,
  ELEMENTOS_DESCARTADOS,
  ELEMENTOS_ESTRUTURA,
  ELEMENTOS_TEXTO,
  ErroThml,
  parsearThml,
  SEPARADOR_DE_LINHA,
} from "../../../scripts/ingest/acervo-parse-thml";

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
const didaque = readFileSync(path.join(FIXTURES, "ccel-lightfoot-didaque-8-10.xml"), "utf8");

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
      '</div2><div2 id="i.tab" title="Synoptical Table"><table><tr><td></td></tr></table></div2>',
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

describe("parsearThml: <verse> é texto da obra (Didaqué 8 a 10: a Oração do Senhor e as orações eucarísticas)", () => {
  const r = parsearThml(didaque, { divisaoSecao: "div2" });
  const todos = r.secoes.flatMap((x) => x.paragrafos);
  const ref = (x: string) => todos.find((q) => q.ref === x);

  it("a Oração do Senhor da Didaqué 8 é um parágrafo próprio, com as linhas unidas pelo separador definido", () => {
    const oracao = ref("ii.xii-p48.3");
    expect(oracao?.texto).toBe(
      [
        "Our Father, which art in heaven,",
        "hallowed be Thy name;",
        "Thy kingdom come;",
        "Thy will be done,",
        "as in heaven, so also on earth;",
        "give us this day our daily bread;",
        "and forgive us our debt,",
        "as we forgive our debtors;",
        "and lead us not into temptation,",
        "but deliver us from the evil one;",
        "for Thine is the power and the glory for ever and ever.",
      ].join(SEPARADOR_DE_LINHA),
    );
    expect(SEPARADOR_DE_LINHA).toBe(" / ");
  });

  it("as orações eucarísticas dos capítulos 9 e 10 estão no texto, com palavras distintivas da origem", () => {
    const tudo = todos.map((q) => q.texto).join("\n");
    for (const palavras of [
      "for the holy vine of Thy son David",
      "As this broken bread was scattered upon the mountains",
      "We give Thee thanks, Holy Father",
      "which Thou hast made to tabernacle in our hearts",
      "didst give food and drink unto men for enjoyment",
      "Remember, Lord, Thy Church",
      "gather it together from the four winds",
      "May grace come and may this world pass away",
    ])
      expect(tudo, palavras).toContain(palavras);
  });

  it("cada estrofe é um parágrafo na ordem do documento, logo depois do <p> que a introduz", () => {
    const refs = todos.map((q) => q.ref);
    expect(refs.indexOf("ii.xii-p48")).toBe(refs.indexOf("ii.xii-p48.3") - 1);
    expect(refs.indexOf("ii.xii-p49")).toBe(refs.indexOf("ii.xii-p48.3") + 1);
    const versos = refs.filter((x) => /-p\d+\.\d+$/.test(x));
    expect(versos).toEqual([
      "ii.xii-p48.3",
      "ii.xii-p51.3",
      "ii.xii-p52.3",
      "ii.xii-p52.9",
      "ii.xii-p54.3",
      "ii.xii-p54.11",
      "ii.xii-p54.17",
      "ii.xii-p54.21",
      "ii.xii-p54.29",
    ]);
  });

  it("nenhuma linha de verso fica de fora: cada <l> da origem aparece no texto", () => {
    const linhas = [...didaque.matchAll(/<l id="[^"]+">([^<]*)<\/l>/g)].map((m) =>
      (m[1] ?? "").split(/\s+/).filter(Boolean).join(" "),
    );
    expect(linhas.length).toBeGreaterThan(30);
    const tudo = todos.map((q) => q.texto).join(SEPARADOR_DE_LINHA);
    for (const l of linhas) expect(tudo, l).toContain(l);
  });

  it("os parágrafos <p> do mesmo trecho não mudam: só ganham as estrofes", () => {
    expect(ref("ii.xii-p48")?.texto).toBe(
      "Neither pray ye as the hypocrites, but as the Lord commanded in His Gospel, thus pray ye:",
    );
  });
});

describe("parsearThml: falha em voz alta (nada some em silêncio)", () => {
  const corpo = (dentro: string) =>
    `<ThML><ThML.head></ThML.head><ThML.body><div1 id="i" title="t"><div2 id="i.i" title="u">${dentro}</div2></div1></ThML.body></ThML>`;
  const ler = (dentro: string) => parsearThml(corpo(dentro), { divisaoSecao: "div2" });

  it("elemento sem regra reprova com o nome, a divisão e a linha", () => {
    const xml = corpo('<p id="i.i-p1">antes</p>\n<poem id="i.i-p2">versos</poem>');
    let erro: Error | undefined;
    try {
      parsearThml(xml, { divisaoSecao: "div2" });
    } catch (e) {
      erro = e as Error;
    }
    expect(erro).toBeInstanceOf(ErroThml);
    expect(erro?.message).toContain("<poem");
    expect(erro?.message).toContain('id="i.i-p2"');
    expect(erro?.message).toContain("divisão i.i");
    expect(erro?.message).toContain("linha 2");
  });

  it("elemento sem regra DENTRO de um parágrafo também reprova (a classe do <foreign>, <blockquote>…)", () => {
    expect(() => ler('<p id="i.i-p1">um <foreign>dois</foreign> três</p>')).toThrow(/<foreign>/);
    expect(() => ler('<p id="i.i-p1">um <blockquote>dois</blockquote></p>')).toThrow(/<blockquote/);
  });

  it("texto solto fora de qualquer bloco reprova, sem nunca virar parágrafo", () => {
    expect(() => ler('<p id="i.i-p1">ok</p>texto solto')).toThrow(/texto fora de qualquer bloco/);
    expect(() => ler("<table><tr><td>célula</td></tr></table>")).toThrow(
      /texto fora de qualquer bloco/,
    );
  });

  it("<verse> e <li> sem id reprovam; <l> fora de <verse> reprova; texto direto no <verse> reprova", () => {
    expect(() => ler("<verse><l>x</l></verse>")).toThrow(/<verse> sem id/);
    expect(() => ler("<ol><li>x</li></ol>")).toThrow(/<li> sem id/);
    expect(() => ler('<p id="i.i-p1"><l id="a">x</l></p>')).toThrow(/<l> fora de <verse>/);
    expect(() => ler('<verse id="v">solto<l id="a">x</l></verse>')).toThrow(/texto fora de <l>/);
  });

  it("bloco dentro de bloco reprova (o texto de um engoliria o do outro)", () => {
    expect(() => ler('<p id="i.i-p1">a<verse id="v"><l id="l">b</l></verse></p>')).toThrow(
      /dentro de um bloco de texto/,
    );
  });

  it("as listas do parser não se cruzam: cada elemento tem UMA regra", () => {
    const todas = [
      ...ELEMENTOS_BLOCO,
      ...ELEMENTOS_TEXTO,
      ...ELEMENTOS_ESTRUTURA,
      ...ELEMENTOS_DESCARTADOS,
    ];
    expect(new Set(todas).size).toBe(todas.length);
  });
});

describe("parsearThml: controles positivos (o que a regra manda manter ou descartar)", () => {
  const corpo = (dentro: string) =>
    `<ThML><ThML.head></ThML.head><ThML.body><div1 id="i" title="t"><div2 id="i.i" title="u">${dentro}</div2></div1></ThML.body></ThML>`;
  const textos = (dentro: string) =>
    parsearThml(corpo(dentro), { divisaoSecao: "div2" }).secoes.flatMap((x) =>
      x.paragrafos.map((q) => q.texto),
    );

  it("inline (i, span, a, q, scripRef, sup, sub) mantém o texto no parágrafo", () => {
    expect(
      textos(
        '<p id="i.i-p1">um <i>dois</i> <span class="Greek">três</span> <a href="#x">quatro</a> <q>cinco</q> <scripRef passage="Mt 1">seis</scripRef> sete<sup>8</sup><sub>9</sub></p>',
      ),
    ).toEqual(["um dois três quatro cinco seis sete89"]);
  });

  it("<li> de lista fora do índice vira parágrafo com o próprio id (os aforismos do ANF 1)", () => {
    expect(
      textos(
        '<ol id="o"><li id="i.i-p2.2">Find time to pray\nwithout ceasing.</li><li id="i.i-p2.3">Segundo.</li></ol>',
      ),
    ).toEqual(["Find time to pray without ceasing.", "Segundo."]);
  });

  it("verso com <br> e um <i> dentro da linha mantém o texto; linha vazia não deixa separador", () => {
    expect(
      textos(
        '<verse id="v"><l id="a">um <i>dois</i></l><l id="b">  </l><l id="c">tres<br />quatro</l></verse>',
      ),
    ).toEqual(["um dois / tres quatro"]);
  });

  it("nota, cabeçalho e índice remissivo ficam fora do texto; notas voltam à parte; a marca vazia não deixa rastro", () => {
    const r = parsearThml(
      corpo(
        '<h2 id="h">Título</h2><p id="i.i-p1">texto<note id="n"><p id="i.i-p2">apparatus</p></note> fim<pb n="7" /><hr /><index id="x" /></p>' +
          '<div class="Index"><ul class="Index1"><li><span>Mt 1</span></li></ul></div><insertIndex id="y" type="t" /><scripCom id="z" />',
      ),
      { divisaoSecao: "div2" },
    );
    expect(r.secoes[0]?.paragrafos.map((q) => q.texto)).toEqual(["texto fim"]);
    expect(r.secoes[0]?.paragrafos[0]?.paginas).toEqual(["7"]);
    expect(r.notas).toEqual(["apparatus"]);
  });

  it("<p> dentro de <td> é lido; bloco fora da divisão da seção é relatado, nunca engolido", () => {
    const xml =
      '<ThML><ThML.head></ThML.head><ThML.body><div1 id="i" title="t"><p id="i-p1">rosto</p>' +
      '<div2 id="i.i" title="u"><table><tr><td><p id="i.i-p1">na célula</p></td></tr></table></div2></div1></ThML.body></ThML>';
    const r = parsearThml(xml, { divisaoSecao: "div2" });
    expect(r.secoes[0]?.paragrafos.map((q) => q.texto)).toEqual(["na célula"]);
    expect(r.blocosForaDeSecao).toEqual(["i-p1"]);
  });
});

describe("parsearThml: o volume REAL em cache (pula sem cache)", () => {
  const caminho = caminhoDoBruto(PASTA_BRUTO, "ccel-lightfoot-fathers", "fathers.xml");

  it.skipIf(!existsSync(caminho))(
    "Didaqué: a Oração do Senhor e as orações eucarísticas estão no texto; as nove Fontes têm as mesmas divisões",
    () => {
      const r = parsearThml(readFileSync(caminho, "utf8"), { divisaoSecao: "div2" });
      expect(r.secoes).toHaveLength(15);
      const did = r.secoes.find((x) => x.id === "ii.xii");
      const tudo = did?.paragrafos.map((q) => q.texto).join("\n") ?? "";
      expect(tudo).toContain("Our Father, which art in heaven");
      expect(tudo).toContain("for the holy vine of Thy son David");
      expect(tudo).toContain("Remember, Lord, Thy Church");
      const versos = did?.paragrafos.filter((q) => /-p\d+\.\d+$/.test(q.ref)) ?? [];
      expect(versos).toHaveLength(9);
      // o martírio de Policarpo também tem estrofes (a oração do mártir)
      const pol = r.secoes.find((x) => x.id === "ii.xi");
      expect(pol?.paragrafos.filter((q) => /-p\d+\.\d+$/.test(q.ref)).length).toBeGreaterThan(0);
    },
  );
});
