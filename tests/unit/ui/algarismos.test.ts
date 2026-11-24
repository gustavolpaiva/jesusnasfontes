import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Algarismos, comAlgarismos } from "@/components/ui/algarismos";

const html = (no: ReactNode) => renderToStaticMarkup(createElement("p", null, no));

describe("algarismos em Rótulo", () => {
  it("põe cada sequência de dígitos num span `.algarismos` e deixa o resto como está", () => {
    expect(html(comAlgarismos("p. 101"))).toBe('<p>p. <span class="algarismos">101</span></p>');
    expect(html(comAlgarismos("p. 39–53"))).toBe(
      '<p>p. <span class="algarismos">39</span>–<span class="algarismos">53</span></p>',
    );
    expect(html(comAlgarismos("18.63"))).toBe(
      '<p><span class="algarismos">18</span>.<span class="algarismos">63</span></p>',
    );
    expect(html(comAlgarismos("estudo 3 de 12 · 2026"))).toBe(
      '<p>estudo <span class="algarismos">3</span> de <span class="algarismos">12</span> · <span class="algarismos">2026</span></p>',
    );
  });

  it("texto sem dígito volta igual, e o numeral romano (letra de verdade) não é tocado", () => {
    expect(comAlgarismos("Acervo")).toBe("Acervo");
    expect(html(comAlgarismos("p. xi–xii"))).toBe("<p>p. xi–xii</p>");
  });

  it("o componente trata textos e números dos filhos e mantém os elementos", () => {
    const filhos = createElement(
      Algarismos,
      null,
      "Verificada em ",
      createElement("time", { lang: "pt-BR" }, "24 de novembro"),
      " · ",
      7,
    );
    expect(html(filhos)).toBe(
      '<p>Verificada em <time lang="pt-BR">24 de novembro</time> · <span class="algarismos">7</span></p>',
    );
  });
});
