import { describe, expect, it } from "vitest";
import {
  contagemEmTexto,
  FRASE_DO_NIVEL,
  lerNivelDoParametro,
  NIVEIS_NA_ORDEM,
  NOME_DO_NIVEL,
} from "@/modules/acervo/niveis";

// Lista fechada de Níveis (ACER-01, T-02-10): o valor de `?nivel=` só vira Nível se for exatamente um dos
// três; qualquer outra coisa vira `null` ("sem filtro") e nunca chega a uma consulta.

describe("lerNivelDoParametro", () => {
  it.each([
    ["primaria", "primaria"],
    ["academica", "academica"],
    ["confessional", "confessional"],
  ])("aceita %s", (valor, esperado) => {
    expect(lerNivelDoParametro(valor)).toBe(esperado);
  });

  it.each([
    ["aspas e injeção", "primaria' or '1'='1"],
    ["aspas simples", "'"],
    ["aspas duplas", '"'],
    ["porcentagem", "%"],
    ["curinga de like", "prim%"],
    ["ponto e vírgula", "primaria;drop table acervo.fonte"],
    ["maiúscula", "PRIMARIA"],
    ["espaço", " primaria"],
    ["vazio", ""],
    ["nome do protótipo", "__proto__"],
    ["construtor", "constructor"],
    ["rótulo em vez de valor", "Fonte primária"],
  ])("recusa %s", (_rotulo, valor) => {
    expect(lerNivelDoParametro(valor)).toBeNull();
  });

  it("recusa o que não é texto: vetor, indefinido, nulo, número, objeto", () => {
    expect(lerNivelDoParametro(["primaria"])).toBeNull();
    expect(lerNivelDoParametro(["primaria", "academica"])).toBeNull();
    expect(lerNivelDoParametro(undefined)).toBeNull();
    expect(lerNivelDoParametro(null)).toBeNull();
    expect(lerNivelDoParametro(1)).toBeNull();
    expect(lerNivelDoParametro({ nivel: "primaria" })).toBeNull();
  });
});

describe("lista fechada", () => {
  it("a ordem fixa é Fonte primária, Pesquisa acadêmica, Leitura confessional", () => {
    expect(NIVEIS_NA_ORDEM.map((n) => NOME_DO_NIVEL[n])).toEqual([
      "Fonte primária",
      "Pesquisa acadêmica",
      "Leitura confessional",
    ]);
  });

  it("cada Nível tem a frase do glossário", () => {
    expect(FRASE_DO_NIVEL.primaria).toBe("Texto antigo, testemunho direto ou próximo do período.");
    expect(FRASE_DO_NIVEL.academica).toBe(
      "Obra de estudioso que analisa as Fontes primárias com método histórico. Aparece como ficha.",
    );
    expect(FRASE_DO_NIVEL.confessional).toBe(
      "Interpretação de uma tradição cristã, sempre com a tradição nomeada.",
    );
  });
});

describe("contagemEmTexto", () => {
  it("singular e plural por Nível", () => {
    expect(contagemEmTexto("primaria", 0)).toBe("Nenhuma Fonte");
    expect(contagemEmTexto("primaria", 1)).toBe("1 Fonte primária");
    expect(contagemEmTexto("primaria", 39)).toBe("39 Fontes primárias");
    expect(contagemEmTexto("academica", 1)).toBe("1 ficha");
    expect(contagemEmTexto("academica", 25)).toBe("25 fichas");
    expect(contagemEmTexto("confessional", 1)).toBe("1 Fonte de leitura confessional");
    expect(contagemEmTexto("confessional", 3)).toBe("3 Fontes de leitura confessional");
  });

  it("sem filtro: total de Fontes", () => {
    expect(contagemEmTexto(null, 0)).toBe("Nenhuma Fonte");
    expect(contagemEmTexto(null, 1)).toBe("1 Fonte");
    expect(contagemEmTexto(null, 64)).toBe("64 Fontes");
  });
});
