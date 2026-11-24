import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BlocoProveniencia,
  TRADUTOR_NAO_IDENTIFICADO,
} from "@/components/acervo/bloco-proveniencia";
import type { FonteLida } from "@/modules/acervo/consultas";

// ACER-04: a proveniência pública credita o TRADUTOR da obra e o EDITOR do volume em linhas separadas, e quando a
// origem não nomeia o tradutor a página diz isso em vez de inventar um (nem de pôr o editor no lugar dele).

const fonteBase = (): FonteLida["fonte"] => ({
  slug: "obra-de-teste",
  titulo: "Obra de teste",
  autor: null,
  epoca: null,
  nivel: "primaria",
  idioma: "en",
  origemNome: "Origem de teste",
  origemUrl: null,
  licenca: "dp-declarado-pela-origem",
  licencaUrl: null,
  tradutor: null,
  editor: null,
  traducaoAno: null,
  edicao: null,
  traduzidaPorNos: false,
  limitesPt: null,
});

const render = (f: FonteLida["fonte"]) =>
  renderToStaticMarkup(createElement(BlocoProveniencia, { fonte: f }));
const linha = (html: string, termo: string): string | null => {
  const m = new RegExp(`<dt[^>]*>${termo}</dt><dd[^>]*>(.*?)</dd>`).exec(html);
  return m?.[1] ?? null;
};

describe("BlocoProveniencia: tradutor e editor", () => {
  it("mostra o tradutor e o editor em linhas separadas, cada um com o seu rótulo", () => {
    const html = render({
      ...fonteBase(),
      tradutor: "S. Thelwall",
      editor: "Allan Menzies",
      traducaoAno: 1869,
    });
    expect(linha(html, "Tradução")).toBe("<span>S. Thelwall, 1869</span>");
    expect(linha(html, "Editor do volume")).toBe("Allan Menzies");
    expect(linha(html, "Tradução")).not.toContain("Menzies");
    expect(html).not.toContain(TRADUTOR_NAO_IDENTIFICADO);
  });

  it("sem tradutor, diz 'tradutor não identificado na edição' e mantém o editor à parte", () => {
    const html = render({ ...fonteBase(), editor: "Philip Schaff" });
    expect(TRADUTOR_NAO_IDENTIFICADO).toBe("tradutor não identificado na edição");
    expect(linha(html, "Tradução")).toBe("<span>tradutor não identificado na edição</span>");
    expect(linha(html, "Editor do volume")).toBe("Philip Schaff");
    expect(linha(html, "Tradução")).not.toContain("Schaff");
  });

  it("sem tradutor e sem editor, não há linha de editor e a edição aparece junto do aviso", () => {
    const html = render({ ...fonteBase(), edicao: "The Works, 1856" });
    expect(html).toContain("tradutor não identificado na edição");
    expect(linha(html, "Tradução")).toContain("<span>The Works, 1856</span>");
    expect(html).not.toContain("Editor do volume");
  });

  it("traduzida por nós: não afirma que falta tradutor", () => {
    const html = render({ ...fonteBase(), traduzidaPorNos: true });
    expect(html).toContain("Tradução feita por nós");
    expect(html).not.toContain(TRADUTOR_NAO_IDENTIFICADO);
  });
});
