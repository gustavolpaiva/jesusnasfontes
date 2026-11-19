import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chave,
  decompor,
  ErroReferencia,
  LIVROS,
  parsearReferencia,
} from "../../../src/modules/referencias";

type Entrada = { texto: string; origem: "campo-r" | "texto"; semLivro?: boolean };
const artifact = JSON.parse(
  readFileSync(new URL("../../fixtures/referencias-artifact.json", import.meta.url), "utf8"),
) as Entrada[];

describe("parsearReferencia (núcleo)", () => {
  it("Jo 3:16 é um único versículo", () => {
    expect(parsearReferencia("Jo 3:16")).toEqual([{ inicio: 43003016, fim: 43003016 }]);
  });

  it("Jo 13:1-17, 13:34-35 dá dois intervalos", () => {
    expect(parsearReferencia("Jo 13:1-17, 13:34-35")).toEqual([
      { inicio: 43013001, fim: 43013017 },
      { inicio: 43013034, fim: 43013035 },
    ]);
  });

  it("Jo é João e Jó é Jó: a distinção é o acento", () => {
    expect(parsearReferencia("Jo 1:1")[0]?.inicio).toBe(43001001);
    expect(parsearReferencia("Jó 1:1")[0]?.inicio).toBe(18001001);
    expect(parsearReferencia("João 1:1")[0]?.inicio).toBe(43001001);
  });
});

describe("gramática completa", () => {
  it("intervalo entre capítulos: Mt 3:13 a 4:11", () => {
    expect(parsearReferencia("Mt 3:13 a 4:11")).toEqual([{ inicio: 40003013, fim: 40004011 }]);
  });

  it("lista com vírgula, ' e ' e novo livro: Jo 13:1-17, 13:34-35 e Lc 22:14-20", () => {
    expect(parsearReferencia("Jo 13:1-17, 13:34-35 e Lc 22:14-20")).toEqual([
      { inicio: 43013001, fim: 43013017 },
      { inicio: 43013034, fim: 43013035 },
      { inicio: 42022014, fim: 42022020 },
    ]);
  });

  it("travessão, ponto e vírgula e versículo solto na lista", () => {
    expect(parsearReferencia("Jo 3:16–18; 5:1")).toEqual([
      { inicio: 43003016, fim: 43003018 },
      { inicio: 43005001, fim: 43005001 },
    ]);
    expect(parsearReferencia("Jo 3:16, 18")).toEqual([
      { inicio: 43003016, fim: 43003016 },
      { inicio: 43003018, fim: 43003018 },
    ]);
  });

  it("capítulo inteiro usa o último versículo medido: João 18 e Mt 1 e Lc 3", () => {
    const j18 = LIVROS[42]?.ultimoVersiculo[17] as number;
    expect(parsearReferencia("João 18")).toEqual([{ inicio: 43018001, fim: chave(43, 18, j18) }]);
    expect(parsearReferencia("Mt 1 e Lc 3")).toEqual([
      { inicio: 40001001, fim: chave(40, 1, 25) },
      { inicio: 42003001, fim: chave(42, 3, 38) },
    ]);
    expect(parsearReferencia("Mt 5-7")).toEqual([{ inicio: 40005001, fim: chave(40, 7, 29) }]);
  });

  it("livro com número e nome por extenso: 1 Co 15:1-11, 1Co e Atos dos Apóstolos", () => {
    expect(parsearReferencia("1 Co 15:1-11")).toEqual(parsearReferencia("1Co 15:1-11"));
    expect(parsearReferencia("1Co 15:1-11")[0]?.inicio).toBe(46015001);
    expect(parsearReferencia("Atos dos Apóstolos 2:1")[0]?.inicio).toBe(44002001);
  });

  it("livro de um capítulo só: Jd 5 é o versículo 5", () => {
    expect(parsearReferencia("Jd 5")).toEqual([{ inicio: 65001005, fim: 65001005 }]);
  });

  it("livroPadrao resolve referências sem livro", () => {
    expect(parsearReferencia("6:51-58", { livroPadrao: 43 })).toEqual([
      { inicio: 43006051, fim: 43006058 },
    ]);
  });

  it("a chave decompõe de volta para o que foi lido", () => {
    const [i] = parsearReferencia("Mt 3:13 a 4:11");
    expect(decompor((i as { inicio: number }).inicio)).toEqual({
      livro: 40,
      capitulo: 3,
      versiculo: 13,
    });
  });
});

describe("estrita: o que não interpreta falha com a posição", () => {
  const recusas: [string, RegExp][] = [
    ["", /vazia/],
    ["   ", /vazia/],
    ["Mt", /número esperado|livro desconhecido|livro ausente/],
    ["Xx 1:1", /livro desconhecido/],
    ["Mt 29:1", /28 capítulo\(s\); capítulo 29 não existe/],
    ["Mt 5:99", /versículo 99 não existe/],
    ["Mt 5:10-3", /invertido/],
    ["Mt 5:3 foo", /separador esperado/],
    ["Jo 3:16,", /item esperado depois do separador/],
    ["Jo 0:1", /capítulo 0 não existe/],
    ["6:51-58", /livro ausente/],
  ];
  for (const [texto, padrao] of recusas) {
    it(`recusa "${texto}"`, () => {
      expect(() => parsearReferencia(texto)).toThrow(ErroReferencia);
      expect(() => parsearReferencia(texto)).toThrow(padrao);
    });
  }

  it("o erro carrega a posição", () => {
    try {
      parsearReferencia("Mt 5:3 foo");
      expect.unreachable();
    } catch (e) {
      expect((e as ErroReferencia).posicao).toBe(7);
    }
  });
});

describe("toda referência escrita no artifact", () => {
  it("tem 51 referências distintas, 37 do campo r", () => {
    expect(artifact).toHaveLength(51);
    expect(new Set(artifact.map((a) => a.texto)).size).toBe(51);
    expect(artifact.filter((a) => a.origem === "campo-r")).toHaveLength(37);
  });

  const comLivro = artifact.filter((a) => !a.semLivro);
  it.each(comLivro.map((a) => [a.texto]))("interpreta %s e cai em livros válidos", (texto) => {
    const intervalos = parsearReferencia(texto as string);
    expect(intervalos.length).toBeGreaterThan(0);
    for (const iv of intervalos) {
      const a = decompor(iv.inicio);
      const b = decompor(iv.fim);
      expect(LIVROS[a.livro - 1]).toBeDefined();
      expect(iv.inicio).toBeLessThanOrEqual(iv.fim);
      expect(b.capitulo).toBeLessThanOrEqual(
        (LIVROS[b.livro - 1] as { capitulos: number }).capitulos,
      );
    }
  });

  it("toda entrada de origem campo-r interpreta sem erro", () => {
    for (const a of artifact.filter((x) => x.origem === "campo-r")) {
      expect(() => parsearReferencia(a.texto), a.texto).not.toThrow();
    }
  });

  it("as duas sem livro escrito são recusadas pelo nome e passam com o livro do contexto (João)", () => {
    const sem = artifact.filter((a) => a.semLivro);
    expect(sem.map((a) => a.texto)).toEqual(["6:51-58", "7:53 a 8:11"]);
    for (const a of sem) {
      expect(() => parsearReferencia(a.texto), a.texto).toThrow(/livro ausente/);
      expect(() => parsearReferencia(a.texto, { livroPadrao: 43 }), a.texto).not.toThrow();
    }
    expect(parsearReferencia("7:53 a 8:11", { livroPadrao: 43 })).toEqual([
      { inicio: 43007053, fim: 43008011 },
    ]);
  });
});

describe("tabela de livros", () => {
  it("tem 66 livros numerados de 1 a 66, 1189 capítulos e nenhum nome ambíguo", () => {
    expect(LIVROS).toHaveLength(66);
    expect(LIVROS.map((l) => l.numero)).toEqual(Array.from({ length: 66 }, (_, i) => i + 1));
    expect(LIVROS.reduce((s, l) => s + l.capitulos, 0)).toBe(1189);
    for (const l of LIVROS) expect(l.ultimoVersiculo).toHaveLength(l.capitulos);
  });
});
