import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { caminhoDoBruto, PASTA_BRUTO } from "../../../scripts/ingest/acervo-origens";
import { ErroHtml, parsearHtml } from "../../../scripts/ingest/acervo-parse-html";

// Fixture REAL (recorte sem alteração, ver NOTICE.md): a página https://www.gospels.net/thomas do tradutor Mark M.
// Mattison — navegação do site, título, a dedicação ao domínio público, a legenda de símbolos, o Prólogo e os ditos
// 1, 2 e 3; depois do recorte, o título final e o cabeçalho "Notes on Translation". Os ditos 4 a 113 ficaram fora.
//
// Estrutura lida na página (Squarespace): cada dito é um parágrafo centralizado cujo texto inteiro está em
// <strong> ("Saying 47: …") seguido de um ou mais parágrafos de corpo; um parágrafo que só tem &nbsp; separa um
// dito do seguinte. A página inteira está numa só linha física muito longa.
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const tome = readFileSync(path.join(FIXTURES, "gospels-tome-trecho.html"), "utf8");
const OP = { rotuloUnidade: "Saying" };
const textos = (r: ReturnType<typeof parsearHtml>) =>
  r.secoes.flatMap((s) => s.paragrafos.map((p) => p.texto));

describe("parsearHtml: recorte real do Evangelho de Tomé (Mattison)", () => {
  const r = parsearHtml(tome, OP);

  it("uma seção só, com os três ditos do recorte numerados de 1 a 3, cada um um parágrafo", () => {
    expect(r.secoes).toHaveLength(1);
    expect(r.secoes[0]?.slug).toBe("texto");
    expect(r.secoes[0]?.ordem).toBe(1);
    expect(r.secoes[0]?.paragrafos.map((p) => p.ref)).toEqual(["1", "2", "3"]);
    expect(r.secoes[0]?.paragrafos.map((p) => [p.ref_inicio, p.ref_fim])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("o texto é o do corpo de cada dito, sem o título que o tradutor lhe deu", () => {
    const [um, dois, tres] = r.secoes[0]?.paragrafos ?? [];
    expect(um?.texto).toBe(
      'And he said, "Whoever discovers the meaning of these sayings won\'t taste death."',
    );
    expect(
      dois?.texto?.startsWith("Jesus said, \"Whoever seeks shouldn't stop until they find."),
    ).toBe(true);
    // a lacuna do texto copta vem com o sinal que a própria tradução usa (ver legenda de símbolos da página)
    expect(dois?.texto).toContain("they'll be […] amazed");
    expect(
      tres?.texto?.startsWith(
        "Jesus said, \"If your leaders tell you, 'Look, the kingdom is in heaven,'",
      ),
    ).toBe(true);
    for (const p of r.secoes[0]?.paragrafos ?? []) {
      expect(p.texto).not.toContain("True Meaning");
      expect(p.texto).not.toContain("Seek and Find");
      expect(p.texto).not.toContain("Seeking Within");
    }
  });

  it("dito com mais de um parágrafo de corpo vira um só parágrafo, unido por espaço", () => {
    const tres = r.secoes[0]?.paragrafos[2]?.texto ?? "";
    expect(tres).toContain("the fish will precede you.");
    // o segundo parágrafo de corpo do dito 3 vem depois de um espaço, colado na frase anterior
    expect(tres).toMatch(/outside of you\. "When you know yourselves/);
    expect(tres.endsWith('and you are the poverty."')).toBe(true);
    expect(tres.split(" ").length).toBeGreaterThan(60);
    expect(tres).not.toMatch(/ {2}/);
  });

  it("navegação, dedicação, legenda de símbolos, Prólogo, título final e 'Notes on Translation' não viram texto", () => {
    const tudo = textos(r).join("\n");
    for (const trecho of [
      "Welcome",
      "Sayings of Jesus",
      "Gospels.net",
      "committed to the public domain",
      "Mark M. Mattison",
      "Gap in the text",
      "Editorial insertion",
      "Prologue",
      "These are the hidden sayings that the living Jesus spoke",
      "The Gospel According to Thomas",
      "Notes on Translation",
      "RECORTE DE TESTE",
      "&nbsp;",
    ])
      expect(tudo).not.toContain(trecho);
    expect(tudo).not.toMatch(/[<>]/);
  });

  it("o que ficou fora dos ditos volta à parte, para conferir que nada disso entrou num parágrafo", () => {
    // a dedicação inteira, numa só nota (o parágrafo da página, até o fim dele)
    expect(
      r.notas.some(
        (n) =>
          n.startsWith("The following translation has been committed") &&
          n.endsWith("the PDF version."),
      ),
    ).toBe(true);
    expect(r.notas).toContain(
      "These are the hidden sayings that the living Jesus spoke and Didymos Judas Thomas wrote down.",
    );
    expect(r.notas).toContain("Notes on Translation");
    expect(r.notas).toContain("The Gospel According to Thomas");
    for (const nota of r.notas) for (const t of textos(r)) expect(t.includes(nota)).toBe(false);
  });

  it("é determinístico", () => {
    expect(JSON.stringify(parsearHtml(tome, OP))).toBe(JSON.stringify(r));
  });
});

// ---- documentos sintéticos com a estrutura da página ----
const p = (corpo: string) => `<p class="" style="white-space:pre-wrap;">${corpo}</p>`;
const CABECALHO = (n: number, rotulo = "Saying") =>
  `<p style="text-align:center;white-space:pre-wrap;" class=""><strong>${rotulo} ${n}: Título</strong></p>`;
const ESPACO = '<p class="" style="white-space:pre-wrap;">&nbsp;</p>';
const PAGINA = (inteiros: string[]) =>
  `<!doctype html><html lang="en-US"><head><meta charset="utf-8" /><title>Título do site</title></head><body><nav><ul><li><a href="/">Início</a></li></ul></nav><section><div class="sqs-html-content">${inteiros.join("")}</div></section><script>window.x = "Script";</script></body></html>`;

describe("parsearHtml: casos sintéticos", () => {
  it("dito que salta número reprova; número repetido reprova (nunca renumera em silêncio)", () => {
    const salto = PAGINA([CABECALHO(1), p("Um."), ESPACO, CABECALHO(3), p("Três.")]);
    expect(() => parsearHtml(salto, OP)).toThrow(ErroHtml);
    expect(() => parsearHtml(salto, OP)).toThrow(/fora de sequência/);
    const repetido = PAGINA([
      CABECALHO(1),
      p("Um."),
      ESPACO,
      CABECALHO(2),
      p("Dois."),
      ESPACO,
      CABECALHO(2),
      p("Outra vez."),
    ]);
    expect(() => parsearHtml(repetido, OP)).toThrow(/fora de sequência/);
  });

  it("a sequência tem de começar no 1", () => {
    expect(() => parsearHtml(PAGINA([CABECALHO(2), p("Dois.")]), OP)).toThrow(/Saying 1/);
  });

  it("página sem dito nenhum reprova", () => {
    expect(() => parsearHtml(PAGINA([p("Nada."), ESPACO, p("Tampouco.")]), OP)).toThrow(
      /nenhum dito/,
    );
  });

  it("parágrafo comum onde se esperava o dito seguinte encerra a região dos ditos: nada dele entra num dito", () => {
    const r = parsearHtml(
      PAGINA([
        CABECALHO(1),
        p("Um."),
        ESPACO,
        p("Anúncio no meio da página."),
        CABECALHO(2),
        p("Dois."),
      ]),
      OP,
    );
    expect(r.secoes[0]?.paragrafos.map((x) => x.ref)).toEqual(["1"]);
    expect(textos(r).join("\n")).not.toContain("Anúncio");
    expect(r.notas).toContain("Anúncio no meio da página.");
    expect(r.notas).toContain("Saying 2: Título");
  });

  it("parágrafo que começa com <strong>Saying N</strong> mas tem texto fora do negrito não é cabeçalho (notas do tradutor)", () => {
    const notas = PAGINA([
      CABECALHO(1),
      p("Um."),
      ESPACO,
      p('<strong>Saying 13</strong>: "<em>Three things</em>." Or possibly "three words."'),
      p('<strong>Saying 105</strong>: "<em>A bastard</em>." Literally, "the son of a prostitute."'),
    ]);
    const r = parsearHtml(notas, OP);
    expect(r.secoes[0]?.paragrafos.map((x) => x.ref)).toEqual(["1"]);
    expect(textos(r).join("\n")).not.toContain("Three things");
  });

  it("parágrafo centralizado sem negrito logo depois do espaçador também encerra (título final da página real)", () => {
    const r = parsearHtml(
      PAGINA([
        CABECALHO(1),
        p("Um."),
        ESPACO,
        '<p style="text-align:center;" class="">The Gospel<br>According to Thomas</p>',
        ESPACO,
        p("Sobrou."),
      ]),
      OP,
    );
    expect(textos(r)).toEqual(["Um."]);
  });

  it("o rótulo vem do registro e tem de vir seguido do número e de dois-pontos", () => {
    const pt = PAGINA([CABECALHO(1, "Dito"), p("Um."), ESPACO, CABECALHO(2, "Dito"), p("Dois.")]);
    expect(
      parsearHtml(pt, { rotuloUnidade: "Dito" }).secoes[0]?.paragrafos.map((x) => x.ref),
    ).toEqual(["1", "2"]);
    // com o rótulo errado não acha dito nenhum
    expect(() => parsearHtml(pt, OP)).toThrow(/nenhum dito/);
    const semDoisPontos = PAGINA([
      '<p style="text-align:center;"><strong>Saying 1 — Título</strong></p>',
      p("Um."),
    ]);
    expect(() => parsearHtml(semDoisPontos, OP)).toThrow(/nenhum dito/);
  });

  it("quebra <br> dentro do corpo vira espaço; entidades são decodificadas; espaços dobrados são fechados", () => {
    const r = parsearHtml(
      PAGINA([
        CABECALHO(1),
        p("Primeira linha.<br>Segunda&nbsp;linha com   espaço dobrado &amp; acento: ação."),
      ]),
      OP,
    );
    expect(textos(r)).toEqual(["Primeira linha. Segunda linha com espaço dobrado & acento: ação."]);
  });

  it("script, style e comentário não entram nem no texto nem nas notas", () => {
    const r = parsearHtml(
      PAGINA([CABECALHO(1), p("Um."), "<!-- um comentário com palavra secreta -->"]).replace(
        "</body>",
        "<style>.x { content: 'estilo secreto' }</style></body>",
      ),
      OP,
    );
    expect(textos(r)).toEqual(["Um."]);
    expect(r.notas.join(" ")).not.toMatch(/secreta|Script|comentário/);
  });

  it("DOCTYPE com subconjunto interno ou ENTITY é recusado; entrada acima do teto é recusada", () => {
    const mau =
      '<!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
      PAGINA([CABECALHO(1), p("Um.")]);
    expect(() => parsearHtml(mau, OP)).toThrow(ErroHtml);
    expect(() => parsearHtml(tome, { ...OP, maxBytes: 1000 })).toThrow(/teto/);
  });

  it("página adversa numa linha só (centenas de milhares de DOCTYPE sem subconjunto) é lida em tempo linear", () => {
    // A página real do Mattison é uma linha só de 56 mil caracteres. Qualquer busca que, a cada marca, corra até o
    // fim da linha faz trabalho quadrático: nesta entrada (2,9 MB) as duas primeiras versões desta conferência
    // levaram dezenas de segundos, e o teste estoura em 5.
    const linha = `${"<!DOCTYPE x ".repeat(240_000)}>`;
    const html = `<!doctype html><html><body>${linha}${CABECALHO(1)}${p("Um.")}</body></html>`;
    const r = parsearHtml(html, OP);
    expect(textos(r)).toEqual(["Um."]);
    // com o subconjunto interno no fim da mesma linha, recusa (sem ENTITY, para acusar o subconjunto)
    const mau = `<!DOCTYPE ${"x ".repeat(240_000)}[ <!ELEMENT x> ]>`;
    expect(() => parsearHtml(mau, OP)).toThrow(/DOCTYPE com subconjunto interno/);
    // e ENTITY em qualquer lugar recusa
    expect(() => parsearHtml(`${PAGINA([CABECALHO(1), p("Um.")])}<!ENTITY x "y">`, OP)).toThrow(
      /ENTITY/,
    );
  });
});

describe("parsearHtml: a página REAL em cache (114 ditos; pula sem cache)", () => {
  const caminho = caminhoDoBruto(PASTA_BRUTO, "gospels-net-tome-mattison", "thomas.html");

  it.skipIf(!existsSync(caminho))(
    "exatamente 114 ditos, numerados de 1 a 114 sem lacuna, sem navegação nem notas do tradutor",
    () => {
      const r = parsearHtml(readFileSync(caminho, "utf8"), OP);
      const paragrafos = r.secoes.flatMap((s) => s.paragrafos);
      expect(r.secoes.map((s) => s.slug)).toEqual(["texto"]);
      expect(paragrafos).toHaveLength(114);
      expect(paragrafos.map((x) => Number(x.ref))).toEqual(
        Array.from({ length: 114 }, (_, i) => i + 1),
      );
      const porRef = new Map(paragrafos.map((x) => [x.ref, x.texto]));
      expect(porRef.get("1")).toBe(
        'And he said, "Whoever discovers the meaning of these sayings won\'t taste death."',
      );
      expect(
        porRef
          .get("47")
          ?.startsWith("Jesus said, \"It's not possible for anyone to mount two horses"),
      ).toBe(true);
      // o dito 47 tem três parágrafos de corpo: ficam num só
      expect(porRef.get("47")).toContain(
        "A new patch of cloth isn't sewn onto an old coat, because it'd tear apart.",
      );
      expect(porRef.get("114")?.startsWith("Simon Peter said to them")).toBe(true);
      expect(porRef.get("114")?.endsWith('will enter the kingdom of heaven."')).toBe(true);
      const tudo = paragrafos.map((x) => x.texto).join("\n");
      for (const trecho of [
        "Welcome",
        "Gospels.net",
        "committed to the public domain",
        "Notes on Translation",
        "The Gospel According to Thomas",
        "These are the hidden sayings that the living Jesus spoke",
        "True Meaning",
        "&nbsp;",
      ])
        expect(tudo).not.toContain(trecho);
      expect(tudo).not.toMatch(/[<>]/);
      // nenhuma nota (parágrafo de fora da região dos ditos) entrou num dito
      expect(r.notas.length).toBeGreaterThan(5);
      for (const nota of r.notas)
        for (const t of porRef.values()) expect(t.includes(nota)).toBe(false);
    },
  );
});
