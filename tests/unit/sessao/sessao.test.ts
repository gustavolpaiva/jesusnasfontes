import { describe, expect, it } from "vitest";
import { ANOTACAO_DA_SESSAO_MAX, validarAnotacaoDaSessao } from "@/modules/sessao/anotacao";
import {
  formatarData,
  formatarDuracao,
  formatarHora,
  mesmoDia,
  minutosEntre,
} from "@/modules/sessao/formato";
import { posicaoDaFolha } from "@/modules/sessao/teclado";

describe("Anotação da Sessão", () => {
  it("aceita até 200 e recusa 201 (o limite é o do campo)", () => {
    expect(validarAnotacaoDaSessao("a".repeat(ANOTACAO_DA_SESSAO_MAX))).toEqual({
      ok: true,
      valor: "a".repeat(ANOTACAO_DA_SESSAO_MAX),
    });
    expect(validarAnotacaoDaSessao("a".repeat(ANOTACAO_DA_SESSAO_MAX + 1))).toEqual({ ok: false });
  });

  it("é opcional: nulo, vazio e só espaços viram nulo", () => {
    for (const vazio of [null, undefined, "", "   \n "]) {
      expect(validarAnotacaoDaSessao(vazio)).toEqual({ ok: true, valor: null });
    }
  });

  it("tira as pontas e o NUL; recusa o que não é texto", () => {
    expect(validarAnotacaoDaSessao("  oi\u0000 mundo ")).toEqual({ ok: true, valor: "oi mundo" });
    for (const ruim of [1, {}, [], true])
      expect(validarAnotacaoDaSessao(ruim)).toEqual({ ok: false });
  });
});

describe("formato da Sessão (fuso de São Paulo, não o do servidor)", () => {
  // 17:05 UTC = 14:05 em São Paulo (UTC-3, sem horário de verão).
  const instante = new Date("2026-11-12T17:05:00Z");

  it("hora e data no fuso do grupo", () => {
    expect(formatarHora(instante)).toBe("14:05");
    expect(formatarData(instante)).toBe("12/11");
  });

  it("meia-noite de São Paulo é um dia novo, mesmo que em UTC ainda seja o mesmo dia", () => {
    const antes = new Date("2026-11-13T02:50:00Z"); // 12/11 23:50 em São Paulo
    const depois = new Date("2026-11-13T03:10:00Z"); // 13/11 00:10 em São Paulo
    expect(mesmoDia(antes, depois)).toBe(false);
    expect(formatarHora(antes)).toBe("23:50");
    expect(formatarHora(depois)).toBe("00:10");
    expect(mesmoDia(instante, new Date("2026-11-12T20:00:00Z"))).toBe(true);
  });

  it("duração em minutos inteiros, arredondada e nunca negativa", () => {
    expect(minutosEntre(instante, new Date(instante.getTime() + 17 * 60_000))).toBe(17);
    expect(minutosEntre(instante, new Date(instante.getTime() + 89_000))).toBe(1);
    expect(minutosEntre(instante, new Date(instante.getTime() + 20_000))).toBe(0);
    expect(minutosEntre(instante, new Date(instante.getTime() - 5 * 60_000))).toBe(0);
    // Espaço sem quebra: o número e "min" não se separam na quebra de linha.
    expect(formatarDuracao(17)).toBe("17\u00a0min");
  });
});

describe("folha sob o teclado de tela", () => {
  it("sem teclado a folha fica na base, com a altura da janela", () => {
    expect(posicaoDaFolha(844, { height: 844, offsetTop: 0 })).toEqual({
      alturaMaxima: 844,
      deslocamentoDaBase: 0,
    });
  });

  it("com o teclado a folha sobe pelo que o teclado cobre e encolhe para a área visível", () => {
    expect(posicaoDaFolha(844, { height: 520, offsetTop: 0 })).toEqual({
      alturaMaxima: 520,
      deslocamentoDaBase: 324,
    });
  });

  it("se o viewport visível desceu, o teclado cobre menos; nunca fica negativo", () => {
    expect(posicaoDaFolha(844, { height: 520, offsetTop: 100 })).toEqual({
      alturaMaxima: 520,
      deslocamentoDaBase: 224,
    });
    expect(posicaoDaFolha(600, { height: 600, offsetTop: 40 }).deslocamentoDaBase).toBe(0);
  });
});
