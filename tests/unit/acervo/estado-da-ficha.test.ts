import { describe, expect, it } from "vitest";
import {
  type EstadoDaFicha,
  estadoDaFicha,
  faltam,
  motivoDasPaginasFaltantes,
  ORDEM_DA_FILA,
  posicaoNaFila,
  textoDoProgresso,
} from "@/modules/acervo/estado-da-ficha";

// Os cinco estados são DERIVADOS (nunca gravados): função pura sobre conferências, verificação e hash.

const base = { hash: "h2", verificacao: null as { hash: string } | null };

describe("estadoDaFicha", () => {
  it("rascunho: nenhuma página conferida", () => {
    expect(estadoDaFicha({ ...base, conferidos: 0, total: 4 })).toBe("rascunho");
  });
  it("em conferência: algumas páginas conferidas", () => {
    expect(estadoDaFicha({ ...base, conferidos: 1, total: 4 })).toBe("em-conferencia");
    expect(estadoDaFicha({ ...base, conferidos: 3, total: 4 })).toBe("em-conferencia");
  });
  it("pronta: todas conferidas e sem verificação", () => {
    expect(estadoDaFicha({ ...base, conferidos: 4, total: 4 })).toBe("pronta");
  });
  it("ficha sem item com página não tem o que conferir: pronta", () => {
    expect(estadoDaFicha({ ...base, conferidos: 0, total: 0 })).toBe("pronta");
  });
  it("verificada: a verificação tem o hash atual", () => {
    expect(
      estadoDaFicha({ conferidos: 4, total: 4, hash: "h2", verificacao: { hash: "h2" } }),
    ).toBe("verificada");
  });
  it("alterada: a verificação é de um hash antigo, mesmo com todas as páginas conferidas", () => {
    expect(
      estadoDaFicha({ conferidos: 4, total: 4, hash: "h2", verificacao: { hash: "h1" } }),
    ).toBe("alterada");
    expect(
      estadoDaFicha({ conferidos: 0, total: 4, hash: "h2", verificacao: { hash: "h1" } }),
    ).toBe("alterada");
  });
  it("bordas: conferidos fora da faixa são presos entre 0 e o total", () => {
    expect(estadoDaFicha({ ...base, conferidos: 9, total: 4 })).toBe("pronta");
    expect(estadoDaFicha({ ...base, conferidos: -3, total: 4 })).toBe("rascunho");
  });
  it("as cinco saídas são distintas", () => {
    const saidas = new Set<EstadoDaFicha>([
      estadoDaFicha({ ...base, conferidos: 0, total: 2 }),
      estadoDaFicha({ ...base, conferidos: 1, total: 2 }),
      estadoDaFicha({ ...base, conferidos: 2, total: 2 }),
      estadoDaFicha({ conferidos: 2, total: 2, hash: "h", verificacao: { hash: "h" } }),
      estadoDaFicha({ conferidos: 2, total: 2, hash: "h", verificacao: { hash: "antigo" } }),
    ]);
    expect(saidas.size).toBe(5);
  });
});

describe("ordem da fila", () => {
  it("pronta, em conferência, rascunho, alterada, verificada", () => {
    expect(ORDEM_DA_FILA).toEqual([
      "pronta",
      "em-conferencia",
      "rascunho",
      "alterada",
      "verificada",
    ]);
    expect(posicaoNaFila("pronta")).toBeLessThan(posicaoNaFila("verificada"));
    const embaralhadas: EstadoDaFicha[] = [
      "verificada",
      "rascunho",
      "pronta",
      "alterada",
      "em-conferencia",
    ];
    expect([...embaralhadas].sort((a, b) => posicaoNaFila(a) - posicaoNaFila(b))).toEqual([
      ...ORDEM_DA_FILA,
    ]);
  });
});

describe("texto do contrato", () => {
  it("motivo no singular e no plural", () => {
    expect(motivoDasPaginasFaltantes(1)).toBe("Falta 1 página a conferir.");
    expect(motivoDasPaginasFaltantes(5)).toBe("Faltam 5 páginas a conferir.");
  });
  it("faltam nunca é negativo", () => {
    expect(faltam(2, 5)).toBe(3);
    expect(faltam(9, 5)).toBe(0);
    expect(faltam(-1, 5)).toBe(5);
  });
  it("progresso em texto", () => {
    expect(textoDoProgresso(7, 12)).toBe("7 de 12 páginas conferidas");
    expect(textoDoProgresso(0, 1)).toBe("0 de 1 página conferida");
  });
});
