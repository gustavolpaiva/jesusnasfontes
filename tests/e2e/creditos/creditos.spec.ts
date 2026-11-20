import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { parse } from "yaml";

// Créditos (ACER-12): página pública, gerada dos registros, sem nenhuma atribuição cortada.

const datasets = parse(readFileSync("data/datasets.yaml", "utf8")) as Record<
  string,
  { nome: string; credito_literal?: string; autores: string[] }
>;
const biblia = Object.values(datasets).find((d) => d.credito_literal);

test("abre sem sessão e lista as cinco entradas da Fase 1 com os quatro rótulos", async ({
  page,
}) => {
  const resposta = await page.goto("/creditos");
  expect(resposta?.status()).toBe(200);
  await expect(page).toHaveURL(/\/creditos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();
  await expect(page.getByText("O que este site usa, de quem é e sob qual licença.")).toBeVisible();

  const nomes = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  expect(nomes).toEqual([
    "Bíblia Livre (BLIVRE)",
    "Conteúdo dos Estudos",
    "Código",
    "EB Garamond",
    "Cormorant Garamond",
  ]);
  for (const rotulo of ["Autores", "Licença", "Versão ou data", "Alterações feitas por nós"]) {
    await expect(page.getByText(rotulo, { exact: true })).toHaveCount(5);
  }
  // Entradas separadas por filete, sem tabela.
  await expect(page.locator("table")).toHaveCount(0);
});

test("a Bíblia Livre aparece com o crédito literal do registro, a versão e as alterações", async ({
  page,
}) => {
  await page.goto("/creditos");
  const corpo = ((await page.locator("main").textContent()) ?? "").replace(/\s+/g, " ");
  expect(biblia?.credito_literal).toBeTruthy();
  expect(corpo).toContain((biblia?.credito_literal ?? "").replace(/\s+/g, " "));
  expect(corpo).toContain("commit a315a15");
  expect(corpo).toContain("12/01/2025");
  expect(corpo).toContain("os sinais « e » marcam versículos duvidosos");
  // Licenças com endereço: a da Bíblia Livre, a do conteúdo e a das fontes.
  const links = await page
    .locator("main a")
    .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(links).toContain("http://creativecommons.org/licenses/by/3.0/br/");
  expect(links).toContain("https://creativecommons.org/licenses/by-sa/4.0/");
  expect(links).toContain("https://openfontlicense.org");
});

test("sem rolagem horizontal em 320 px no passo 5 do tamanho do texto, e axe zerado", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "escala-texto", value: "5", url: baseURL as string }]);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/creditos");
  await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();
  const estouro = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(estouro).toBeLessThanOrEqual(0);
  // O passo vale na página (o cookie é lido no servidor, também aqui).
  expect(
    await page.evaluate(() => document.documentElement.style.getPropertyValue("--escala-texto")),
  ).toBe("1.5");
  const resultado = await new AxeBuilder({ page }).analyze();
  expect(resultado.violations.map((v) => v.id)).toEqual([]);
});
