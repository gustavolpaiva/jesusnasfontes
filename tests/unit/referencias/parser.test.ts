import { describe, expect, it } from "vitest";
import { parsearReferencia } from "../../../src/modules/referencias/parser";

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
  });
});
