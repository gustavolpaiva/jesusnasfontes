import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { caminhoDoBruto, PASTA_BRUTO } from "../../../scripts/ingest/acervo-origens";
import {
  ErroGutenberg,
  parsearGutenberg,
  separarGutenberg,
} from "../../../scripts/ingest/acervo-parse-gutenberg";

// Fixtures REAIS (recortes sem alteração, ver NOTICE.md):
//   gutenberg-plinio-trecho.txt   eBook #2811 (Melmoth): cabeçalho do Gutenberg com a licença, página de rosto, o
//                                 começo da "Correspondence with the Emperor Trajan" (carta I), as cartas XCVII e
//                                 XCVIII, notas do tradutor e a cauda com a declaração de domínio público. O recorte
//                                 tira as cartas II a XCVI: o parser acusa exatamente essa lacuna.
//   gutenberg-suetonio-bordas.txt eBook #6400: só as duas bordas (marcador de início e de fim); o corpo ficou fora.
// A origem declara `Character set encoding: ISO-8859-1`, por isso a leitura é latin1.
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const plinio = readFileSync(path.join(FIXTURES, "gutenberg-plinio-trecho.txt"), "latin1");
const suetonioBordas = readFileSync(path.join(FIXTURES, "gutenberg-suetonio-bordas.txt"), "utf8");
const PLINIO = {
  estrutura: "cartas" as const,
  secoes: ["trajano"],
  correspondencia: { "trajano.XCVII": "10.96", "trajano.XCVIII": "10.97" },
};
const todos = (r: { secoes: { paragrafos: { ref: string; texto: string }[] }[] }) =>
  r.secoes.flatMap((s) => s.paragrafos);

// ---- documentos sintéticos, com as convenções lidas no arquivo real ----
const MARCAS = (corpo: string) =>
  [
    "The Project Gutenberg EBook of Teste, by Alguem",
    "",
    "*** START OF THE PROJECT GUTENBERG EBOOK TESTE ***",
    "",
    corpo.trim(),
    "",
    "*** END OF THE PROJECT GUTENBERG EBOOK TESTE ***",
    "",
    "End of the Project Gutenberg EBook of Teste",
    "",
  ].join("\n");
const CARTA = (rotulo: string, ...linhas: string[]) =>
  [`${rotulo} -- To ALGUEM`, "", ...linhas].join("\n");
const NOTAS = (primeira: string, ...demais: string[]) =>
  [`FOOTNOTES TO THE LETTERS ${primeira}`, ...demais].join("\n\n");
const PARTE = (titulo: string, cartas: string[], notas?: string) =>
  [titulo, "", ...cartas, ...(notas ? ["", notas] : []), ""].join("\n\n\n");
const OP = { estrutura: "cartas" as const, secoes: ["a", "b"] };
const UMA = { estrutura: "cartas" as const, secoes: ["x"] };
const UM = CARTA("I", "Primeira carta.", "Segunda linha.");

describe("separarGutenberg: bordas e corpo pelos marcadores do próprio arquivo", () => {
  it("Plínio real: o cabeçalho e a licença ficam nas bordas; o corpo não traz nem marcador nem licença", () => {
    const p = separarGutenberg(plinio);
    expect(p.inicio).toContain("This eBook is for the use of anyone anywhere at no cost");
    expect(p.inicio).toContain("Character set encoding: ISO-8859-1");
    expect(p.inicio).toContain("Translator: William Melmoth");
    // a linha do marcador não entra em pedaço nenhum
    expect(p.inicio.trimEnd().endsWith("Character set encoding: ISO-8859-1")).toBe(true);
    expect(p.corpo.startsWith("\n\n\nProduced by David Reed and David Widger")).toBe(true);
    expect(p.fim.startsWith("\n***** This file should be named 2811-8.txt")).toBe(true);
    expect(p.fim).toContain(
      "Creating the works from public domain print editions means that no one\nowns a United States copyright in these works",
    );
    expect(p.corpo).toContain("XCVII To THE EMPEROR TRAJAN[1066]");
    expect(p.corpo).not.toContain("Project Gutenberg License");
    expect(p.corpo).not.toContain("Creating the works");
    expect(p.corpo).not.toContain("*** START");
    expect(p.corpo).not.toContain("*** END");
  });

  it("Suetônio real: as duas bordas são vazias (o marcador de início é a linha 1 e o de fim é a última)", () => {
    const s = separarGutenberg(suetonioBordas);
    expect(s.inicio).toBe("");
    expect(s.fim).toBe("");
    expect(s.corpo.trim()).toBe("");
  });

  it("sem marcador de início, sem marcador de fim, ou com o de fim antes do de início, reprova", () => {
    expect(() => separarGutenberg("só texto")).toThrow(ErroGutenberg);
    expect(() => separarGutenberg("*** START OF THE PROJECT GUTENBERG EBOOK X ***\ncorpo")).toThrow(
      /fim/,
    );
    expect(() =>
      separarGutenberg(
        "*** END OF THE PROJECT GUTENBERG EBOOK X ***\n*** START OF THE PROJECT GUTENBERG EBOOK X ***",
      ),
    ).toThrow(ErroGutenberg);
  });

  it("aceita as duas grafias dos marcadores (EBOOK e ETEXT; THE e THIS)", () => {
    const a = separarGutenberg(MARCAS("corpo"));
    expect(a.corpo.trim()).toBe("corpo");
    const b = separarGutenberg(
      "*** START OF THIS PROJECT GUTENBERG ETEXT X ***\ncorpo\n*** END OF THE PROJECT GUTENBERG ETEXT X ***",
    );
    expect(b.corpo.trim()).toBe("corpo");
  });
});

describe("parsearGutenberg: recorte real do Plínio (Melmoth), estrutura de cartas", () => {
  const r = parsearGutenberg(plinio, PLINIO);
  const porRef = (x: string) => todos(r).find((p) => p.ref === x);

  it("uma seção, com o título e o slug do registro, e as cartas I, XCVII e XCVIII do recorte", () => {
    expect(r.secoes.map((s) => [s.slug, s.titulo, s.ordem])).toEqual([
      ["trajano", "CORRESPONDENCE WITH THE EMPEROR TRAJAN", 1],
    ]);
    expect(todos(r).map((p) => p.ref)).toEqual(["trajano.I", "10.96", "10.97"]);
    expect(r.secoes[0]?.paragrafos.map((p) => [p.ref_inicio, p.ref_fim])).toEqual([
      [null, null],
      [null, null],
      [null, null],
    ]);
  });

  it("10.96 e 10.97 vêm da tabela de correspondência: XCVII é a carta aos cristãos e XCVIII a resposta de Trajano", () => {
    const carta = porRef("10.96");
    expect(
      carta?.texto.startsWith("IT is my invariable rule, Sir, to refer to you in all matters"),
    ).toBe(true);
    expect(carta?.texto).toContain("Christians");
    expect(carta?.texto).toContain("an absurd and extravagant superstition");
    const resposta = porRef("10.97");
    expect(resposta?.texto.startsWith("You have adopted the right course")).toBe(true);
    expect(resposta?.texto).toContain("investigating the charges against the Christians");
    expect(resposta?.texto.endsWith("quite foreign to the spirit of our age.")).toBe(true);
  });

  it("nenhum marcador de nota fica no texto, nem no meio da carta nem no cabeçalho dela", () => {
    for (const p of todos(r)) expect(p.texto).not.toMatch(/\[\d+\]/);
    expect(porRef("trajano.I")?.texto).not.toContain("[1001]");
    expect(porRef("trajano.I")?.texto).not.toContain("[1002]");
    expect(porRef("10.96")?.texto).not.toContain("[1067]");
    // a frase continua inteira onde o marcador foi tirado
    expect(porRef("10.96")?.texto).toContain("citizens, I directed them to be sent");
    expect(porRef("10.96")?.texto).toContain("those who shall repent of their error.");
  });

  it("o cabeçalho da carta (destinatário) não entra no texto, como o `head` do TEI", () => {
    expect(porRef("10.96")?.texto).not.toContain("To THE EMPEROR TRAJAN");
    expect(porRef("10.97")?.texto).not.toContain("TRAJAN TO PLINY");
  });

  it("nem o bloco de licença, nem o cabeçalho do Gutenberg, nem a página de rosto viram parágrafo", () => {
    const texto = todos(r)
      .map((p) => p.texto)
      .join("\n");
    for (const trecho of [
      "Creating the works",
      "Project Gutenberg",
      "This eBook is for the use",
      "Translated by William Melmoth",
      "Revised by F. C. T. Bosanquet",
      "End of the Project Gutenberg EBook",
      "This file should be named",
    ])
      expect(texto).not.toContain(trecho);
  });

  it("as notas do tradutor vão à parte e nenhuma aparece num parágrafo", () => {
    expect(
      r.notas.some((n) => n.startsWith("This letter is esteemed as almost the only genuine")),
    ).toBe(true);
    expect(
      r.notas.some((n) => n.startsWith("It was one of the privileges of a Roman citizen")),
    ).toBe(true);
    // a nota 1001 vem colada ao cabeçalho do bloco de notas no arquivo real
    expect(r.notas.some((n) => n.startsWith("The greater part of the following letters"))).toBe(
      true,
    );
    expect(r.notas.join(" ")).not.toContain("(return)");
    for (const nota of r.notas) for (const p of todos(r)) expect(p.texto).not.toContain(nota);
  });

  it("carta fora da tabela mantém a numeração de Melmoth e é relatada", () => {
    expect(r.foraDaTabela).toEqual(["trajano.I"]);
    expect(
      porRef("trajano.I")?.texto.startsWith("THE pious affection you bore, most sacred Emperor"),
    ).toBe(true);
  });

  it("o recorte tirou as cartas II a XCVI: o parser acusa exatamente as ausentes, do II ao XCVI", () => {
    expect(r.ausentes).toHaveLength(95);
    expect(r.ausentes[0]).toBe("trajano.II");
    expect(r.ausentes.at(2)).toBe("trajano.IV");
    expect(r.ausentes.at(42)).toBe("trajano.XLIV");
    expect(r.ausentes.at(-1)).toBe("trajano.XCVI");
  });

  it("o texto sai sem quebra de linha, sem espaço dobrado e sem espaço antes da pontuação", () => {
    for (const p of todos(r)) {
      expect(p.texto).not.toMatch(/[\n\t]/);
      expect(p.texto).not.toMatch(/ {2}/);
      expect(p.texto).toBe(p.texto.trim());
    }
  });

  it("é determinístico", () => {
    expect(JSON.stringify(parsearGutenberg(plinio, PLINIO))).toBe(JSON.stringify(r));
  });
});

describe("parsearGutenberg: casos sintéticos com as convenções do arquivo real", () => {
  it("as duas partes têm numeração que recomeça: os rótulos não se confundem e cada parte é uma seção", () => {
    const r = parsearGutenberg(
      MARCAS(
        PARTE(
          "LETTERS GAIUS PLINIUS",
          [UM, CARTA("II", "Segunda.")],
          NOTAS("] 1 (return) [ Nota um.]"),
        ) +
          PARTE("CORRESPONDENCE WITH THE EMPEROR TRAJAN", [
            CARTA("I", "Outra primeira."),
            CARTA("II", "Outra segunda."),
          ]),
      ),
      { ...OP, secoes: ["cartas", "trajano"] },
    );
    expect(r.secoes.map((s) => [s.slug, s.titulo, s.ordem])).toEqual([
      ["cartas", "LETTERS GAIUS PLINIUS", 1],
      ["trajano", "CORRESPONDENCE WITH THE EMPEROR TRAJAN", 2],
    ]);
    expect(todos(r).map((p) => p.ref)).toEqual([
      "cartas.I",
      "cartas.II",
      "trajano.I",
      "trajano.II",
    ]);
    expect(r.ausentes).toEqual([]);
    expect(r.notas).toEqual(["Nota um."]);
  });

  it("traço ausente, TO maiúsculo e resposta do imperador: são cabeçalhos de carta", () => {
    const r = parsearGutenberg(
      MARCAS(
        PARTE("PARTE UNICA", [
          "I -- To ALGUEM\n\nUm.",
          "II To OUTRO\n\nDois.",
          "III TO UM TERCEIRO\n\nTres.",
          "IV TRAJAN TO PLINY\n\nQuatro.",
        ]),
      ),
      { estrutura: "cartas", secoes: ["x"] },
    );
    expect(todos(r).map((p) => p.ref)).toEqual(["x.I", "x.II", "x.III", "x.IV"]);
    expect(r.ausentes).toEqual([]);
  });

  it("numeral com espaço no meio (LX VI) é lido como LXVI, e a lacuna antes dele vem com numeral canônico", () => {
    const r = parsearGutenberg(
      MARCAS(
        PARTE("PARTE UNICA", [
          "I -- To ALGUEM\n\nUm.",
          "LX V -- To ALGUEM\n\nSessenta e cinco.",
          "LX VI -- To ALGUEM\n\nSessenta e seis.",
        ]),
      ),
      { estrutura: "cartas", secoes: ["x"] },
    );
    expect(todos(r).map((p) => p.ref)).toEqual(["x.I", "x.LXV", "x.LXVI"]);
    expect(r.ausentes).toHaveLength(63);
    expect(r.ausentes[0]).toBe("x.II");
    expect(r.ausentes.at(-1)).toBe("x.LXIV");
  });

  it("título seguido de carta que não é a I não é reconhecido como parte: reprova (é o molde do índice)", () => {
    expect(() =>
      parsearGutenberg(MARCAS(PARTE("PARTE UNICA", [CARTA("II", "Dois.")])), UMA),
    ).toThrow(ErroGutenberg);
    expect(() =>
      parsearGutenberg(MARCAS(PARTE("PARTE UNICA", [CARTA("II", "Dois.")])), UMA),
    ).toThrow(/nenhuma parte/);
  });

  it("carta repetida ou fora de ordem reprova (nunca reordena nem junta em silêncio)", () => {
    const repetida = MARCAS(
      PARTE("PARTE UNICA", [UM, CARTA("II", "Dois."), CARTA("II", "De novo.")]),
    );
    expect(() => parsearGutenberg(repetida, UMA)).toThrow(/fora de sequência/);
    const regressiva = MARCAS(
      PARTE("PARTE UNICA", [UM, CARTA("III", "Tres."), CARTA("II", "Dois.")]),
    );
    expect(() => parsearGutenberg(regressiva, UMA)).toThrow(/fora de sequência/);
  });

  it("numeral mal formado no cabeçalho reprova com o rótulo lido", () => {
    const mau = MARCAS(PARTE("PARTE UNICA", [CARTA("I", "Um."), CARTA("IIIV", "Dois.")]));
    expect(() => parsearGutenberg(mau, UMA)).toThrow(/mal formado/);
  });

  it("lacuna na origem: a carta II ausente entre I e III é relatada como ausente, com o slug da parte", () => {
    const r = parsearGutenberg(MARCAS(PARTE("PARTE UNICA", [UM, CARTA("III", "Tres.")])), UMA);
    expect(todos(r).map((p) => p.ref)).toEqual(["x.I", "x.III"]);
    expect(r.ausentes).toEqual(["x.II"]);
    expect(todos(r)[1]?.texto).toBe("Tres.");
  });

  it("título da parte seguido de texto solto não é reconhecido como parte: reprova em voz alta", () => {
    const solto = MARCAS(
      ["PARTE UNICA", "", "Uma dedicatória solta.", "", CARTA("I", "Um.")].join("\n"),
    );
    expect(() => parsearGutenberg(solto, UMA)).toThrow(/nenhuma parte/);
    // e a dedicatória nunca viraria parágrafo: sem parte não há saída
    expect(() => parsearGutenberg(solto, UMA)).toThrow(ErroGutenberg);
  });

  it("linha em branco no meio da mesma carta (citação, edital) vira um só parágrafo, unido por espaço", () => {
    const r = parsearGutenberg(
      MARCAS(
        PARTE("PARTE UNICA", [
          CARTA(
            "I",
            "Antes da citação.",
            "",
            "DEPOIS da linha em branco.",
            "ainda no segundo bloco.",
          ),
        ]),
      ),
      UMA,
    );
    expect(todos(r)).toHaveLength(1);
    expect(todos(r)[0]?.texto).toBe(
      "Antes da citação. DEPOIS da linha em branco. ainda no segundo bloco.",
    );
  });

  it("carta sem texto nenhum reprova (cabeçalho logo seguido do cabeçalho seguinte)", () => {
    const vazia = MARCAS(PARTE("PARTE UNICA", [UM, "II -- To ALGUEM\n\nIII -- To OUTRO\n\nTres."]));
    expect(() => parsearGutenberg(vazia, UMA)).toThrow(/sem texto/);
    expect(() => parsearGutenberg(vazia, UMA)).toThrow(/x\.II/);
  });

  it("etiqueta HTML deixada pela conversão sai do texto, mesmo partida em duas linhas, e leva o marcador junto", () => {
    const r = parsearGutenberg(
      MARCAS(
        PARTE("PARTE UNICA", [
          [
            "I -- To ALGUEM",
            "",
            "her modesty,",
            "",
            '"She took great care to fall with decency."<a href="#linknote-70"',
            'name="linknoteref-70" id="linknoteref-70">[70]</a>',
            "",
            'Celer likewise persisted in exclaiming, "What have I done?--I have done nothing." These declarations[71]',
          ].join("\n"),
        ]),
      ),
      UMA,
    );
    expect(todos(r)[0]?.texto).toBe(
      'her modesty, "She took great care to fall with decency." Celer likewise persisted in exclaiming, "What have I done?--I have done nothing." These declarations',
    );
  });

  it("'&c.' é texto da obra e fica; marcação HTML desconhecida reprova em vez de vazar para o texto", () => {
    const ok = parsearGutenberg(
      MARCAS(PARTE("PARTE UNICA", [CARTA("I", 'legacy in the following words, "I give, &c.-"')])),
      UMA,
    );
    expect(todos(ok)[0]?.texto).toContain("&c.");
    const estranha = MARCAS(
      PARTE("PARTE UNICA", [CARTA("I", "texto com <span>marca</span> desconhecida.")]),
    );
    expect(() => parsearGutenberg(estranha, UMA)).toThrow(/marcação/);
  });

  it("toda entrada da tabela tem de corresponder a uma carta do arquivo; duas cartas não podem virar a mesma referência", () => {
    const doc = MARCAS(PARTE("PARTE UNICA", [UM, CARTA("II", "Dois.")]));
    expect(() =>
      parsearGutenberg(doc, { ...OP, secoes: ["x"], correspondencia: { "x.XCIX": "10.1" } }),
    ).toThrow(/correspondência/);
    expect(() =>
      parsearGutenberg(doc, {
        ...OP,
        secoes: ["x"],
        correspondencia: { "x.I": "10.1", "x.II": "10.1" },
      }),
    ).toThrow(/repetida/);
  });

  it("mais partes no arquivo do que slugs no registro reprova, e um slug sem parte também", () => {
    const duas = MARCAS(PARTE("PRIMEIRA PARTE", [UM]) + PARTE("SEGUNDA PARTE", [UM]));
    expect(() => parsearGutenberg(duas, { estrutura: "cartas", secoes: ["so-uma"] })).toThrow(
      /sem slug/,
    );
    expect(() =>
      parsearGutenberg(MARCAS(PARTE("PRIMEIRA PARTE", [UM])), {
        estrutura: "cartas",
        secoes: ["a", "b"],
      }),
    ).toThrow(/sem parte/);
  });

  it("introdução e índice antes da primeira parte ficam fora; sem parte reconhecida reprova", () => {
    const comIndice = MARCAS(
      [
        "GAIUS PLINIUS was born at Como in 62 A. D. He was only eight years old.",
        "",
        "CONTENTS",
        "",
        "LETTERS GAIUS PLINIUS CAECILIUS SECUNDUS",
        "",
        "I -- To SEPTITTUS",
        "",
        "II -- To ARRIANUS",
        "",
        "FOOTNOTES TO THE LETTERS",
        "",
        PARTE(
          "LETTERS GAIUS PLINIUS CAECILIUS SECUNDUS",
          [CARTA("I -- To SEPTITTUS", "YOU have frequently pressed me.")],
          NOTAS("] 1 (return) [ Nota um.]"),
        ).trim(),
      ].join("\n\n"),
    );
    const r = parsearGutenberg(comIndice, { estrutura: "cartas", secoes: ["cartas"] });
    expect(r.secoes.map((s) => s.titulo)).toEqual(["LETTERS GAIUS PLINIUS CAECILIUS SECUNDUS"]);
    expect(todos(r).map((p) => p.ref)).toEqual(["cartas.I"]);
    expect(todos(r)[0]?.texto).toBe("YOU have frequently pressed me.");
    expect(r.notas).toEqual(["Nota um."]);
    expect(() => parsearGutenberg(MARCAS("só uma introdução sem parte"), UMA)).toThrow(
      /nenhuma parte/,
    );
  });

  it("entrada acima do teto é recusada", () => {
    expect(() => parsearGutenberg(plinio, { ...PLINIO, maxBytes: 1000 })).toThrow(/teto/);
  });
});

describe("parsearGutenberg: o arquivo REAL do Plínio em cache (plano 02-27; pula sem cache)", () => {
  const caminho = caminhoDoBruto(PASTA_BRUTO, "gutenberg-plinio-2811", "2811-8.txt");
  const tabela = { "trajano.XCVII": "10.96", "trajano.XCVIII": "10.97" };
  const opcoes = {
    estrutura: "cartas" as const,
    secoes: ["cartas", "trajano"],
    correspondencia: tabela,
  };

  it.skipIf(!existsSync(caminho))(
    "duas partes, 231 cartas (109 + 122), só a XLIV ausente na origem, 229 fora da tabela e 247 notas fora do texto",
    () => {
      const r = parsearGutenberg(readFileSync(caminho, "latin1"), opcoes);
      expect(r.secoes.map((s) => [s.slug, s.paragrafos.length])).toEqual([
        ["cartas", 109],
        ["trajano", 122],
      ]);
      expect(r.ausentes).toEqual(["cartas.XLIV"]);
      expect(r.foraDaTabela).toHaveLength(229);
      expect(r.notas).toHaveLength(247);
      const porRef = new Map(todos(r).map((p) => [p.ref, p.texto]));
      expect(porRef.get("10.96")).toContain(
        "Christians is this: I asked them whether they were Christians",
      );
      expect(porRef.get("10.97")).toContain("investigating the charges against the Christians");
      expect(porRef.get("cartas.I")).toContain(
        "YOU have frequently pressed me to make a select collection",
      );
      expect(
        porRef.get("cartas.XXX")?.startsWith("I DID not tell you, when I paid you my last visit"),
      ).toBe(true);
      // os numerais com espaço no meio no arquivo (LX VII, LXX VII, LXXX VIII, XXX VII, LX VIII, LXX IV)
      for (const ref of [
        "cartas.LXVII",
        "cartas.LXXVII",
        "cartas.LXXXVIII",
        "trajano.XXXVII",
        "trajano.LXVIII",
        "trajano.LXXIV",
      ])
        expect(porRef.has(ref), ref).toBe(true);
      // a última carta do arquivo
      expect(porRef.get("trajano.CXXII")?.length ?? 0).toBeGreaterThan(0);
      for (const p of todos(r)) expect(p.texto).not.toMatch(/\[\d+\]/);
      for (const p of todos(r)) expect(p.texto).not.toMatch(/<[a-z]/i);
      for (const nota of r.notas) expect(nota.length).toBeGreaterThan(0);
      // como o derivador confere (`conferirEsperado`): nota de 40+ caracteres dentro de parágrafo é vazamento.
      // Nota curta ("Domitian", "Trajan") aparece como palavra comum do texto e não é sinal de nada.
      const longas = r.notas.filter((n) => n.length >= 40);
      expect(longas.length).toBeGreaterThan(150);
      for (const nota of longas)
        for (const p of todos(r)) expect(p.texto.includes(nota), p.ref).toBe(false);
    },
  );
});

describe("parsearGutenberg: falha em voz alta (nada some em silêncio)", () => {
  it("marcação HTML que o parser não conhece, no texto da carta, reprova (controle positivo: <a> e [N] saem)", () => {
    const com = (linha: string) =>
      MARCAS(PARTE("PARTE UNICA", [CARTA("I", "Antes.", linha, "Depois.")]));
    expect(() => parsearGutenberg(com("um <b>negrito</b> aqui"), UMA)).toThrow(/marcação HTML/);
    const ok = parsearGutenberg(com('um <a href="#n1">trecho</a>[12] aqui'), UMA);
    expect(todos(ok)[0]?.texto).toBe("Antes. um trecho aqui Depois.");
  });

  it("texto solto no bloco de notas, fora de qualquer nota, reprova com a linha (a frase de fim do Gutenberg passa)", () => {
    const notas = [
      "FOOTNOTES TO THE LETTERS 1 (return) [ Primeira nota.]",
      "",
      "Parágrafo perdido que não é de nota nenhuma.",
    ].join("\n");
    expect(() => parsearGutenberg(MARCAS(PARTE("PARTE UNICA", [UM], notas)), UMA)).toThrow(
      /texto fora de qualquer nota.*linha \d+.*Parágrafo perdido/,
    );
    const boa = parsearGutenberg(
      MARCAS(
        PARTE(
          "PARTE UNICA",
          [UM],
          "FOOTNOTES TO THE LETTERS 1 (return) [ Primeira nota.]\n\nEnd of the Project Gutenberg EBook of Teste",
        ),
      ),
      UMA,
    );
    expect(boa.notas).toEqual(["Primeira nota."]);
  });
});
