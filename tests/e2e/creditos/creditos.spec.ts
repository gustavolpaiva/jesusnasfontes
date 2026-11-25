import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { parse } from "yaml";

// Créditos (ACER-12): página pública, gerada dos registros, sem nenhuma atribuição cortada. As entradas
// da Fase 1 continuam como estavam; depois delas vem a seção "Textos do Acervo", com uma entrada por origem
// de que o site usa ao menos uma Fonte publicada. Nenhum número do Acervo é fixo: tudo é lido do registro
// de origens e dos YAMLs de Fonte.

type Origem = {
  nome: string;
  url_licenca: string;
  fonte: string;
  commit: string;
  arquivos: { slug: string }[];
};

const datasets = parse(readFileSync("data/datasets.yaml", "utf8")) as Record<
  string,
  { nome: string; credito_literal?: string }
>;
const biblia = Object.values(datasets).find((d) => d.credito_literal);
const origens = parse(readFileSync("data/acervo-origens.yaml", "utf8")) as Record<string, Origem>;

type Fonte = { slug: string; publicada: boolean; tipo_texto: string };
const publicadas = new Set(
  readdirSync(join("content", "acervo", "fontes"))
    .filter((nome) => nome.endsWith(".yaml"))
    .map((nome) => parse(readFileSync(join("content", "acervo", "fontes", nome), "utf8")) as Fonte)
    .filter((f) => f.publicada && f.tipo_texto === "integral")
    .map((f) => f.slug),
);
// As Fontes publicadas que a origem alimenta: o que o site usa dela.
const usadasDa = (o: Origem) => o.arquivos.map((a) => a.slug).filter((s) => publicadas.has(s));
// As origens de que o site usa ao menos uma Fonte publicada, com a chave de cada uma, na ordem do registro.
const usadas = Object.entries(origens).filter(([, o]) => usadasDa(o).length > 0);
const daFamilia = (prefixo: string) => usadas.filter(([chave]) => chave.startsWith(prefixo));

const DA_FASE_1 = [
  "Bíblia Livre (BLIVRE)",
  "Conteúdo dos Estudos",
  "Código",
  "EB Garamond",
  "Cormorant Garamond",
];
const ROTULOS_DA_FASE_1 = ["Autores", "Licença", "Versão ou data", "Alterações feitas por nós"];

const secao = (page: Page) => page.locator('[data-slot="creditos-do-acervo"]');
/** A entrada (`li`) cujo título de nível 3 é este nome. */
const entrada = (page: Page, nome: string) =>
  page
    .locator("li")
    .filter({ has: page.getByRole("heading", { level: 3, name: nome, exact: true }) });
/** A linha (`dd`) de um rótulo, dentro de uma entrada. */
const linha = (daEntrada: Locator, rotulo: string) =>
  daEntrada
    .locator("dl > div")
    .filter({ has: daEntrada.page().locator("dt").getByText(rotulo, { exact: true }) })
    .locator("dd");

test.describe.configure({ timeout: 60_000 });

test("abre sem sessão: as cinco entradas da Fase 1 intactas e, depois, a seção Textos do Acervo", async ({
  page,
}) => {
  const resposta = await page.goto("/creditos");
  expect(resposta?.status()).toBe(200);
  await expect(page).toHaveURL(/\/creditos$/);
  await expect(page.getByRole("heading", { level: 1, name: "Créditos" })).toBeVisible();
  await expect(page.getByText("O que este site usa, de quem é e sob qual licença.")).toBeVisible();

  // Na ordem de leitura: as cinco entradas da Fase 1 em h2, o título da seção em h2 e cada entrada do
  // Acervo em h3, uma por origem usada, na ordem do registro.
  expect(await page.getByRole("heading", { level: 2 }).allInnerTexts()).toEqual([
    ...DA_FASE_1,
    "Textos do Acervo",
  ]);
  expect(await page.getByRole("heading", { level: 3 }).allInnerTexts()).toEqual(
    usadas.map(([, o]) => o.nome),
  );

  // Sem tabela, sem acordeão e sem botão: tudo visível sem tocar em nada.
  await expect(page.locator("main table")).toHaveCount(0);
  await expect(page.locator("main button")).toHaveCount(0);
  await expect(page.locator("main [data-slot='accordion'], main [aria-expanded]")).toHaveCount(0);

  // Cada entrada tem os quatro rótulos da Fase 1; "Usado em" só existe na seção do Acervo, um por entrada.
  for (const rotulo of ROTULOS_DA_FASE_1)
    await expect(page.getByText(rotulo, { exact: true })).toHaveCount(
      DA_FASE_1.length + usadas.length,
    );
  await expect(page.getByText("Usado em", { exact: true })).toHaveCount(usadas.length);
  await expect(secao(page).getByText("Usado em", { exact: true })).toHaveCount(usadas.length);
  // Uma entrada por origem usada (só as linhas da lista; as linhas de autor também são `li`).
  await expect(secao(page).locator(":scope > ul > li")).toHaveCount(usadas.length);
});

test("uma entrada de cada família (Perseus, CCEL, Gutenberg, gospels.net), com a licença e o endereço do registro", async ({
  page,
}) => {
  await page.goto("/creditos");
  for (const prefixo of ["perseus-", "ccel-", "gutenberg-", "gospels-"]) {
    const familia = daFamilia(prefixo);
    expect(familia.length, `origem da família ${prefixo}`).toBeGreaterThan(0);
    for (const [chave, o] of familia) {
      const e = entrada(page, o.nome);
      await expect(e, chave).toHaveCount(1);
      // A licença é link para o endereço do registro.
      await expect(linha(e, "Licença").locator("a"), chave).toHaveAttribute("href", o.url_licenca);
      // O endereço de origem é o do registro; só repositório do GitHub com commit ganha a árvore.
      const esperado = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(o.fonte)
        ? `${o.fonte}/tree/${o.commit}`
        : o.fonte;
      await expect(linha(e, "Versão ou data").locator("a"), chave).toHaveAttribute(
        "href",
        esperado,
      );
      if (prefixo !== "perseus-") expect(esperado, chave).not.toContain("/tree/");
    }
  }
});

test("'Usado em' tem um link para a página de cada Fonte publicada, em frase corrida", async ({
  page,
}) => {
  await page.goto("/creditos");
  const links = secao(page).locator("dd a[href^='/acervo/']");
  // Cada Fonte publicada aparece uma vez, e só as publicadas aparecem.
  const hrefs = (await links.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).sort();
  expect(hrefs).toEqual([...publicadas].map((s) => `/acervo/${s}`).sort());
  // Por origem, os dela.
  for (const [chave, o] of usadas) {
    const daEntrada = await linha(entrada(page, o.nome), "Usado em")
      .locator("a")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(daEntrada.sort(), chave).toEqual(
      usadasDa(o)
        .map((s) => `/acervo/${s}`)
        .sort(),
    );
  }
  // Link de prosa: em linha (isento dos 44 px, WCAG 2.5.8) e visível sem tocar em nada.
  for (const link of await links.all()) {
    await expect(link).toBeVisible();
    expect(await link.evaluate((a) => getComputedStyle(a).display)).toBe("inline");
  }
});

test("a origem do Perseus mostra a licença da edição digital e a da tradução separadas; Mattison, a dedicação", async ({
  page,
}) => {
  await page.goto("/creditos");
  const josefo = usadas.find(([, o]) => usadasDa(o).includes("josefo-antiguidades"))?.[1];
  const mattison = usadas.find(([, o]) => usadasDa(o).includes("evangelho-de-tome"))?.[1];
  expect(josefo).toBeDefined();
  expect(mattison).toBeDefined();
  // Texto fixo do vocabulário de licença do Acervo (o mesmo da página da Fonte).
  await expect(linha(entrada(page, josefo?.nome ?? ""), "Licença")).toContainText(
    "Edição digital: CC BY-SA. Tradução de William Whiston, 1737: domínio público.",
  );
  await expect(linha(entrada(page, mattison?.nome ?? ""), "Licença")).toHaveText(
    "Domínio público, dedicado pelo tradutor",
  );
  await expect(entrada(page, mattison?.nome ?? "")).toContainText("Mark M. Mattison");
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
