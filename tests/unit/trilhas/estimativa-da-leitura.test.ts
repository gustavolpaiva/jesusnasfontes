import { describe, expect, it } from "vitest";
import { chave } from "@/modules/referencias/chave";
import { estimarVersiculos } from "@/modules/trilhas/estimativa-da-leitura";

const mt = (cap: number, v: number) => chave(40, cap, v);

describe("estimarVersiculos (altura reservada do esqueleto da Leitura)", () => {
  it("conta os versículos de um trecho no mesmo capítulo", () => {
    expect(estimarVersiculos([{ inicio: mt(5, 1), fim: mt(5, 16) }])).toBe(16);
    expect(estimarVersiculos([{ inicio: chave(42, 18, 9), fim: chave(42, 18, 14) }])).toBe(6);
  });

  it("soma as Passagens do Estudo", () => {
    expect(
      estimarVersiculos([
        { inicio: chave(42, 18, 9), fim: chave(42, 18, 14) },
        { inicio: mt(18, 21), fim: mt(18, 35) },
      ]),
    ).toBe(6 + 15);
  });

  it("cruzando capítulo, nunca passa do real (Mt 3:13 a 4:11 tem 16; a estimativa é 12)", () => {
    const n = estimarVersiculos([{ inicio: mt(3, 13), fim: mt(4, 11) }]);
    expect(n).toBe(12);
    expect(n).toBeLessThanOrEqual(5 + 11);
  });

  it("capítulo inteiro (fim no último versículo possível) fica no teto", () => {
    expect(estimarVersiculos([{ inicio: mt(5, 1), fim: mt(5, 999) }])).toBe(60);
  });

  it("sem Passagem, zero; chave ilegível não derruba a página", () => {
    expect(estimarVersiculos([])).toBe(0);
    expect(estimarVersiculos([{ inicio: 5, fim: 9 }])).toBe(0);
  });
});
