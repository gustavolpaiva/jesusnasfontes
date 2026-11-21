import { expect, test } from "@playwright/test";
import { prepararTela, TELAS } from "./telas";

// UI-03 (plano 01-19): em 320 px, com o passo 5 do tamanho do texto (o maior), nenhuma tela tem rolagem
// horizontal, texto cortado nem ação fora da janela, e todo alvo de toque mede pelo menos 44 por 44 px
// (link dentro de prosa é isento). Roda nos projetos de 320 px (claro e escuro).

type Medida = {
  sobraDaPagina: number;
  cortados: string[];
  foraDaJanela: string[];
  pequenos: string[];
  interativos: number;
};

for (const tela of TELAS) {
  test(`@varredura reflow em 320 px no passo 5: ${tela.id}`, async ({ page, context, baseURL }) => {
    test.setTimeout(90_000);
    test.skip(page.viewportSize()?.width !== 320, "só a largura de 320 px");
    await context.addCookies([
      { name: "escala-texto", value: "5", url: baseURL ?? "http://localhost" },
    ]);
    await prepararTela(page, tela);
    // O passo 5 está de fato aplicado (controle positivo): a escala do texto da raiz é a máxima.
    const escala = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--escala-texto").trim(),
    );
    expect(Number(escala)).toBeGreaterThan(1);

    const m: Medida = await page.evaluate(() => {
      const nome = (el: Element) =>
        `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}: ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}`;
      // Texto só para leitor de tela (`.sr-only`) e o link de salto são recortados por técnica: fora.
      const visivel = (el: Element) => {
        if (el.closest(".sr-only")) return false;
        const r = el.getBoundingClientRect();
        const c = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && c.visibility !== "hidden" && c.display !== "none";
      };
      const largura = document.documentElement.clientWidth;
      const doTexto = [
        ...document.querySelectorAll("h1,h2,h3,p,li,label,a,button,span,td,th"),
      ].filter(visivel);
      const cortados = doTexto
        .filter((el) => {
          const c = getComputedStyle(el);
          const corta = c.overflowX !== "visible" || c.overflowY !== "visible";
          return (
            corta && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)
          );
        })
        .map(nome);
      const interativos = [
        ...document.querySelectorAll(
          'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="checkbox"], [role="switch"], [role="tab"]',
        ),
      ].filter(visivel);
      // O link de salto fica fora da tela até receber foco (é a técnica dele): não entra nas medidas.
      // Fora das medidas: o link de salto (recortado por técnica) e o `input` escondido que o Radix põe ao
      // lado do checkbox (`aria-hidden`, `tabindex=-1`): quem recebe o toque é o botão do checkbox.
      const medidos = interativos.filter(
        (el) =>
          !el.closest(".sr-only") &&
          !el.closest('[aria-hidden="true"]') &&
          el.getAttribute("tabindex") !== "-1" &&
          el.getBoundingClientRect().width > 1,
      );
      const foraDaJanela = medidos
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < -1 || r.right > largura + 1;
        })
        .map(nome);
      const pequenos = medidos
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width >= 44 && r.height >= 44) return false;
          if (el.tagName === "A") {
            const pai = el.parentElement;
            const emProsa =
              getComputedStyle(el).display === "inline" &&
              !!pai &&
              [...pai.childNodes].some(
                (n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0,
              );
            if (emProsa) return false;
          }
          return true;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${nome(el)} (${Math.round(r.width)}x${Math.round(r.height)})`;
        });
      return {
        sobraDaPagina: document.documentElement.scrollWidth - largura,
        cortados,
        foraDaJanela,
        pequenos,
        interativos: medidos.length,
      };
    });

    expect(m.sobraDaPagina, "rolagem horizontal da página").toBeLessThanOrEqual(0);
    expect(m.cortados, "texto cortado").toEqual([]);
    expect(m.foraDaJanela, "ação fora da janela").toEqual([]);
    expect(m.pequenos, "alvo de toque abaixo de 44 px").toEqual([]);
  });
}
