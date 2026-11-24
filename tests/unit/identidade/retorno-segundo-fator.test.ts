import { describe, expect, it } from "vitest";
import {
  destinoDepoisDoSegundoFator,
  enderecoDoSegundoFator,
  PREFIXOS_DE_RETORNO,
  ROTAS_DE_RETORNO,
  retornoSeguro,
} from "@/modules/identidade/retorno-segundo-fator";

// O retorno do segundo fator é entrada não confiável (T-02-47): lista fechada de prefixo e forma estrita do resto.

describe("retornoSeguro", () => {
  it("controle positivo: o caminho de uma ficha é aceito", () => {
    expect(retornoSeguro("/admin/acervo/fichas/obra-de-teste")).toBe(
      "/admin/acervo/fichas/obra-de-teste",
    );
    expect(retornoSeguro("/admin/acervo/fichas/obra.de_teste~1")).not.toBeNull();
  });

  it.each([
    ["endereço externo", "https://externo.invalid/pego"],
    ["sem esquema, com duas barras", "//externo.invalid/pego"],
    ["barra dupla depois do prefixo", "/admin/acervo/fichas//externo.invalid"],
    ["fora da lista de prefixos", "/admin/convites"],
    ["a administração inteira", "/admin"],
    ["o prefixo sem a ficha", "/admin/acervo/fichas/"],
    ["a fila sem barra final", "/admin/acervo/fichas"],
    ["subcaminho", "/admin/acervo/fichas/a/b"],
    ["voltar um nível", "/admin/acervo/fichas/.."],
    ["ponto", "/admin/acervo/fichas/."],
    ["volta escondida", "/admin/acervo/fichas/../../convites"],
    ["barra invertida", "/admin/acervo/fichas/a\\b"],
    ["porcentagem", "/admin/acervo/fichas/%2e%2e"],
    ["consulta", "/admin/acervo/fichas/a?x=1"],
    ["âncora", "/admin/acervo/fichas/a#x"],
    ["dois-pontos", "/admin/acervo/fichas/javascript:alert(1)"],
    ["espaço", "/admin/acervo/fichas/a b"],
    ["quebra de linha", "/admin/acervo/fichas/a\nb"],
    ["maiúsculas", "/admin/acervo/fichas/ABC"],
    ["não ASCII", "/admin/acervo/fichas/ação"],
    ["resto longo demais", `/admin/acervo/fichas/${"a".repeat(161)}`],
    ["vazio", ""],
  ])("recusa %s", (_nome, valor) => {
    expect(retornoSeguro(valor)).toBeNull();
  });

  it("recusa o que não é texto", () => {
    for (const v of [null, undefined, 3, {}, ["/admin/acervo/fichas/a"], new File([], "a")])
      expect(retornoSeguro(v)).toBeNull();
  });

  it("a lista de prefixos é fechada e só tem caminhos internos de administração", () => {
    expect(PREFIXOS_DE_RETORNO).toEqual(["/admin/acervo/fichas/"]);
    for (const p of PREFIXOS_DE_RETORNO) {
      expect(p.startsWith("/admin/")).toBe(true);
      expect(p.endsWith("/")).toBe(true);
    }
  });
});

describe("rotas exatas (plano 02-21)", () => {
  it("a lista de graus propostos é aceita, e só ela", () => {
    expect(ROTAS_DE_RETORNO).toEqual(["/admin/acervo/graus"]);
    expect(retornoSeguro("/admin/acervo/graus")).toBe("/admin/acervo/graus");
  });

  it.each([
    ["barra final", "/admin/acervo/graus/"],
    ["subcaminho", "/admin/acervo/graus/a"],
    ["consulta", "/admin/acervo/graus?filtro=todas"],
    ["âncora", "/admin/acervo/graus#x"],
    ["maiúsculas", "/admin/acervo/GRAUS"],
    ["prefixo parecido", "/admin/acervo/grausx"],
    ["externo com o mesmo final", "https://externo.invalid/admin/acervo/graus"],
    ["barra dupla", "//admin/acervo/graus"],
  ])("recusa %s", (_nome, valor) => {
    expect(retornoSeguro(valor)).toBeNull();
  });
});

describe("destino e endereço", () => {
  it("sem retorno aceito o destino é a administração", () => {
    expect(destinoDepoisDoSegundoFator("https://externo.invalid")).toBe("/admin");
    expect(destinoDepoisDoSegundoFator(null)).toBe("/admin");
    expect(destinoDepoisDoSegundoFator("/admin/acervo/fichas/obra")).toBe(
      "/admin/acervo/fichas/obra",
    );
  });
  it("o endereço do segundo fator só leva o retorno aceito, e o leva codificado", () => {
    expect(enderecoDoSegundoFator("/admin/segundo-fator", "/admin/acervo/fichas/obra")).toBe(
      "/admin/segundo-fator?retorno=%2Fadmin%2Facervo%2Ffichas%2Fobra",
    );
    expect(enderecoDoSegundoFator("/admin/segundo-fator", "https://externo.invalid")).toBe(
      "/admin/segundo-fator",
    );
  });
});
