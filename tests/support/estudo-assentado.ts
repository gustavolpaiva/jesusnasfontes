import { expect, type Locator, type Page } from "@playwright/test";
import { instalarFalaFalsa, VOZ_PT_BR } from "./fala-falsa";

// A página do Estudo muda de altura DEPOIS de carregada, por duas razões que não dependem do teste,
// e um teste que mede posição (ou clica num botão que fica abaixo) no meio dessa mudança falha de vez
// em quando (plano 02-03: `afirmacao-divergencia`, `cinza`). Medido com um observador de layout na
// página (`ResizeObserver` em todos os elementos, `rAF` na posição da Divergência):
//
//   1. O texto bíblico (`Leitura`) chega por streaming: até a troca, a seção é o esqueleto "Carregando o
//      texto…" (173 px); depois, o texto de verdade (~1,3 mil px). Tudo o que vem abaixo desce
//      ~1137 px, e o instante da troca depende da carga do servidor (de 0,7 a mais de 1 s).
//   2. Cada controle "Ouvir" (há dois na página) mostra "Procurando voz em português…" (22,5 px de
//      linha + 8 px de margem = 30,5 px) enquanto o navegador não entrega as vozes, e tira a linha
//      quando `voiceschanged` chega: dois degraus de +30,5 px e uma queda de 61 px. Com a voz do
//      sistema (macOS) isso leva de 0,5 a 1 s depois de carregar a página; sem voz nenhuma, 2 s.
//
// A correção não é esperar mais tempo: é tirar a incerteza. A voz vem de um motor de fala falso que
// já tem a voz em português na primeira leitura (o relógio do sistema deixa de decidir), e a troca do
// texto bíblico é esperada como estado (o esqueleto sai da página).

/**
 * Instala, antes de qualquer script da página, um motor de fala com a voz pt-BR já disponível: a
 * busca de voz termina na hora e a linha "Procurando voz…" nunca aparece. Chamar ANTES de navegar.
 * Os testes de `ouvir` reinstalam o próprio motor depois (o último a ser instalado vale).
 */
export async function usarVozImediata(page: Page): Promise<void> {
  await instalarFalaFalsa(page, { vozes: [VOZ_PT_BR] });
}

/**
 * Espera o Estudo parar de se mexer por causa do que chega depois: o texto bíblico no lugar do
 * esqueleto e as fontes da página carregadas. Chamar depois de `page.goto` de um Estudo.
 */
export async function esperarEstudoAssentado(page: Page): Promise<void> {
  await expect(page.locator("#leitura-carregando")).toHaveCount(0, { timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

export type Caixa = { x: number; y: number; width: number; height: number };

/**
 * Mede vários elementos no MESMO instante: uma só passada de layout. Medir um a um, com um
 * `boundingBox()` por chamada, deixa o layout mudar entre as chamadas.
 */
export async function medirJuntos(page: Page, alvos: Locator[]): Promise<Caixa[]> {
  const nos = await Promise.all(alvos.map((a) => a.elementHandle()));
  const presentes = nos.map((n, i) => {
    if (!n) throw new Error(`medirJuntos: o alvo ${i} não está na página`);
    return n;
  });
  return page.evaluate(
    (els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    presentes,
  );
}
