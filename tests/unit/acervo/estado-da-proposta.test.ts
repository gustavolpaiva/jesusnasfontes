import { describe, expect, it } from "vitest";
import {
  contarFiltros,
  type EntradaDoEstadoDaProposta,
  estadoDaProposta,
  estaNoFiltro,
  lerFiltro,
  motivoDaFichaFaltando,
  motivoDoBotao,
  rotuloDoBotao,
} from "@/modules/acervo/estado-da-proposta";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const C1 = "c".repeat(64);
const C2 = "d".repeat(64);

const base: EntradaDoEstadoDaProposta = {
  propostaTextoHash: H1,
  afirmacaoTextoHash: H1,
  aprovacao: null,
  citacoesHash: C1,
  fichasNaoVerificadas: 0,
  alvosSustentam: true,
};

describe("estadoDaProposta", () => {
  it("controle positivo: sem aprovação, com texto igual e fichas verificadas, é pendente", () => {
    expect(estadoDaProposta(base)).toBe("pendente");
  });

  it("aprovada só com os DOIS hashes válidos e os alvos sustentando", () => {
    const aprovacao = { textoHash: H1, citacoesHash: C1 };
    expect(estadoDaProposta({ ...base, aprovacao })).toBe("aprovada");
    // texto da aprovação velho: o banco a esconde, a tela a mostra pendente
    expect(estadoDaProposta({ ...base, aprovacao: { ...aprovacao, textoHash: H2 } })).toBe(
      "pendente",
    );
    // conjunto de Citações mudou depois da aprovação
    expect(estadoDaProposta({ ...base, aprovacao: { ...aprovacao, citacoesHash: C2 } })).toBe(
      "pendente",
    );
    // Fonte despublicada depois: a aprovação não vale
    expect(estadoDaProposta({ ...base, aprovacao, alvosSustentam: false })).toBe("pendente");
  });

  it("texto mudado vence tudo: ficha faltando e aprovação", () => {
    expect(estadoDaProposta({ ...base, afirmacaoTextoHash: H2 })).toBe("texto-mudou");
    expect(estadoDaProposta({ ...base, afirmacaoTextoHash: H2, fichasNaoVerificadas: 2 })).toBe(
      "texto-mudou",
    );
    expect(
      estadoDaProposta({
        ...base,
        afirmacaoTextoHash: H2,
        aprovacao: { textoHash: H2, citacoesHash: C1 },
      }),
    ).toBe("texto-mudou");
  });

  it("ficha não verificada: aguardando ficha, mesmo com aprovação de hashes iguais", () => {
    expect(estadoDaProposta({ ...base, fichasNaoVerificadas: 1, alvosSustentam: false })).toBe(
      "aguardando-ficha",
    );
    expect(
      estadoDaProposta({
        ...base,
        fichasNaoVerificadas: 1,
        alvosSustentam: false,
        aprovacao: { textoHash: H1, citacoesHash: C1 },
      }),
    ).toBe("aguardando-ficha");
  });
});

describe("filtros", () => {
  const estados = ["pendente", "aprovada", "aguardando-ficha", "texto-mudou", "aprovada"] as const;

  it("conta pendentes como tudo o que não está aprovado", () => {
    expect(contarFiltros(estados)).toEqual({ pendentes: 3, aprovadas: 2, todas: 5 });
    expect(contarFiltros([])).toEqual({ pendentes: 0, aprovadas: 0, todas: 0 });
  });

  it("estaNoFiltro concorda com a contagem", () => {
    for (const f of ["pendentes", "aprovadas", "todas"] as const)
      expect(estados.filter((s) => estaNoFiltro(s, f)).length).toBe(contarFiltros(estados)[f]);
  });

  it("lerFiltro aceita só os três valores e cai em pendentes", () => {
    expect(lerFiltro("aprovadas")).toBe("aprovadas");
    expect(lerFiltro(["todas", "x"])).toBe("todas");
    for (const v of [undefined, "", "rejeitadas", "TODAS", 3, null, {}])
      expect(lerFiltro(v)).toBe("pendentes");
  });
});

describe("motivo e rótulo do botão", () => {
  it("o texto mudado vence a ficha", () => {
    expect(
      motivoDoBotao({ estado: "texto-mudou", fichasFaltando: ["Obra"], fontesFaltando: [] }),
    ).toBe("Esta frase mudou depois da proposta. Recarregue as propostas.");
  });

  it("ficha faltando dá o motivo com a obra; duas obras se juntam com 'e'", () => {
    expect(
      motivoDoBotao({ estado: "aguardando-ficha", fichasFaltando: ["A"], fontesFaltando: [] }),
    ).toBe("Falta verificar a ficha de A.");
    expect(motivoDaFichaFaltando(["A", "B", "C"])).toBe("Falta verificar a ficha de A, B e C.");
  });

  it("Fonte não publicada também sem efeito, com o motivo", () => {
    expect(
      motivoDoBotao({ estado: "pendente", fichasFaltando: [], fontesFaltando: ["Josefo"] }),
    ).toBe("Falta publicar a Fonte Josefo.");
  });

  it("sem impedimento não há motivo", () => {
    expect(
      motivoDoBotao({ estado: "pendente", fichasFaltando: [], fontesFaltando: [] }),
    ).toBeNull();
    expect(
      motivoDoBotao({ estado: "aprovada", fichasFaltando: [], fontesFaltando: [] }),
    ).toBeNull();
  });

  it("o rótulo muda quando o valor escolhido difere do proposto", () => {
    expect(rotuloDoBotao("consenso", "consenso")).toBe("Aprovar este grau");
    expect(rotuloDoBotao("disputada", "consenso")).toBe("Aprovar o grau corrigido");
  });
});
