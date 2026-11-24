import type { Page } from "@playwright/test";

export type AlgarismoEmVersalete = { onde: string; texto: string };

/**
 * Todo texto visível que traz algarismo e está em versalete (`font-variant-caps: small-caps`): na EB
 * Garamond o versalete desenha o algarismo como letra ("p. 101" vira "p. ioi"). Texto só para leitor de
 * tela (`.sr-only`) e o que não se vê não entram. Lista vazia = nenhum algarismo ambíguo na tela.
 */
export async function algarismosEmVersalete(page: Page): Promise<AlgarismoEmVersalete[]> {
  return page.evaluate(() => {
    const caminho = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${
        el.getAttribute("data-slot") ? `[${el.getAttribute("data-slot")}]` : ""
      }`;
    const saida: { onde: string; texto: string }[] = [];
    const visitante = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let no = visitante.nextNode(); no; no = visitante.nextNode()) {
      const texto = no.textContent ?? "";
      const pai = no.parentElement;
      if (!pai || !/\d/.test(texto)) continue;
      if (pai.closest(".sr-only, script, style, noscript, [hidden]")) continue;
      const r = pai.getBoundingClientRect();
      const c = getComputedStyle(pai);
      if (r.width === 0 || r.height === 0 || c.visibility === "hidden" || c.display === "none") {
        continue;
      }
      if (c.fontVariantCaps === "small-caps" || c.fontVariantCaps === "all-small-caps") {
        saida.push({
          onde: `${caminho(pai)} < ${pai.parentElement ? caminho(pai.parentElement) : ""}`,
          texto: texto.trim().slice(0, 60),
        });
      }
    }
    return saida;
  });
}
