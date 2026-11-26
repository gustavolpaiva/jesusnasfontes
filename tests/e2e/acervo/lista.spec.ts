import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Lista do Acervo (ACER-01, D-13): o Estudante abre /acervo pela navegação, vê as Fontes agrupadas por
// Nível, filtra e nunca é levado a uma lista vazia. As contagens são RELATIVAS à PRÓPRIA render (a
// contagem exibida é igual ao número de linhas da mesma página): outros testes semeiam e removem fichas
// verificadas no mesmo banco de e2e o tempo todo, então um número lido numa render anterior não vale na
// seguinte. Roda sobre o recorte real do Josefo semeado por `scripts/dev/e2e.ts`.

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("acervo-lista");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

const grupo = (page: Page, nivel: string) =>
  page.locator(`[data-slot="grupo-nivel"][data-nivel="${nivel}"]`);

test("o item Acervo da navegação de quatro itens leva à lista, ativo com aria-current", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/trilhas");
  const faixa = page.getByRole("navigation", { name: "Seções" }).filter({ visible: true });
  const links = faixa.getByRole("link");
  await expect(links).toHaveText(["Trilhas", "Acervo", "Caderno", "Conta"]);
  await faixa.getByRole("link", { name: "Acervo" }).click();
  await expect(page).toHaveURL(/\/acervo$/);
  await expect(page.getByRole("heading", { level: 1, name: "Acervo" })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Seções" })
      .filter({ visible: true })
      .getByRole("link", { name: "Acervo" }),
  ).toHaveAttribute("aria-current", "page");
});

test("agrupa por Nível, a contagem é a das linhas e o filtro seleciona por forma e aria-current", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/acervo");
  await expect(page.getByRole("heading", { level: 1, name: "Acervo" })).toBeVisible();

  // A Fonte semeada (Josefo) está no grupo Fonte primária.
  const primaria = grupo(page, "primaria");
  await expect(primaria.getByRole("heading", { level: 2 })).toContainText("Fonte primária");
  const josefo = primaria.getByRole("link", { name: "Antiguidades Judaicas" });
  await expect(josefo).toHaveAttribute("href", "/acervo/josefo-antiguidades");
  await expect(primaria).toContainText("Flávio Josefo · cerca de 93 d.C. · texto em inglês");

  // Contagem relativa: a do cabeçalho do grupo e a do item do filtro são o número de linhas.
  const linhas = await primaria.locator('[data-slot="linha-fonte"]').count();
  expect(linhas).toBeGreaterThanOrEqual(1);
  await expect(primaria.locator('[data-slot="contagem-grupo"]')).toHaveText(`(${linhas})`);
  const filtro = page.getByRole("navigation", { name: "Nível de fonte" });
  const itemPrimaria = filtro.getByRole("link", { name: /^Fonte primária/ });
  await expect(itemPrimaria).toContainText(`(${linhas})`);
  await expect(filtro.getByRole("link", { name: "Todos" })).toHaveAttribute("aria-current", "true");

  // D-13: nenhum item de filtro com zero Fontes.
  for (const texto of await filtro.getByRole("link").allInnerTexts()) {
    const n = /\((\d+)\)/.exec(texto);
    if (n) expect(Number(n[1])).toBeGreaterThan(0);
  }

  // Filtrar: seleção por aria-current e por preenchimento invertido (não só cor); só o grupo escolhido.
  await itemPrimaria.click();
  await expect(page).toHaveURL(/\/acervo\?nivel=primaria$/);
  const marcado = page
    .getByRole("navigation", { name: "Nível de fonte" })
    .getByRole("link", { name: /^Fonte primária/ });
  await expect(marcado).toHaveAttribute("aria-current", "true");
  await expect(marcado.locator("svg")).toHaveCount(1);
  const fundo = await marcado.evaluate((el) => getComputedStyle(el).backgroundColor);
  const textoCor = await marcado.evaluate((el) => getComputedStyle(el).color);
  expect(fundo).not.toBe(textoCor);
  await expect(page.locator('[data-slot="grupo-nivel"]')).toHaveCount(1);
  // A contagem é da render FILTRADA (o clique refaz a lista no servidor): nunca o número da
  // página anterior, que outros testes podem ter mudado no banco entre uma e outra.
  const linhasDoFiltro = await page.locator('[data-slot="linha-fonte"]').count();
  expect(linhasDoFiltro).toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-slot="contagem-acervo"]')).toHaveText(
    linhasDoFiltro === 1 ? "1 Fonte primária" : `${linhasDoFiltro} Fontes primárias`,
  );
  await expect(marcado).toContainText(`(${linhasDoFiltro})`);
  await expect(page.locator('[data-slot="linha-fonte"]')).toHaveCount(linhasDoFiltro);
});

test("Nível sem Fonte ou valor desconhecido no endereço mostra a lista completa com o aviso", async ({
  page,
}) => {
  await entrar(page);

  for (const endereco of [
    "/acervo?nivel=confessional",
    "/acervo?nivel=inexistente",
    "/acervo?nivel=primaria%27%20or%20%271%27%3D%271",
    "/acervo?nivel=primaria&nivel=academica",
  ]) {
    await page.goto(endereco);
    const aviso = page.getByRole("status").filter({ hasText: "Não há Fontes neste Nível ainda." });
    // `confessional` só tem Fonte quando algum plano a semeia; o aviso vale enquanto não houver.
    if (endereco.endsWith("confessional") && (await grupo(page, "confessional").count()) > 0)
      continue;
    await expect(aviso).toContainText("Aviso.");
    await expect(aviso).toContainText("Mostramos todas.");
    // A lista é completa na PRÓPRIA render, sem número de render anterior: a contagem da página é
    // a das linhas e a Fonte do recorte (Josefo) está entre elas. Um total lido antes valia menos
    // quando outros testes semeavam ou removiam fichas entre as cargas (era a falha emparelhada).
    const contagem = page.locator('[data-slot="contagem-acervo"]');
    await expect(contagem).toHaveText(/^(\d+) Fontes?$/);
    const n = Number(/\d+/.exec((await contagem.textContent()) ?? ""));
    await expect(page.locator('[data-slot="linha-fonte"]')).toHaveCount(n);
    await expect(
      page.locator('[data-slot="linha-fonte"]').filter({ hasText: "Antiguidades Judaicas" }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("navigation", { name: "Nível de fonte" }).getByRole("link", { name: "Todos" }),
    ).toHaveAttribute("aria-current", "true");
  }
});

test("a lista não tem rolagem horizontal, tem alvos de 44 px e passa no axe", async ({ page }) => {
  await entrar(page);
  await page.goto("/acervo");
  await expect(page.getByRole("heading", { level: 1, name: "Acervo" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const alturas = await page
    .locator('[data-slot="filtro-nivel-item"], [data-slot="linha-fonte"]')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(alturas.length).toBeGreaterThan(1);
  for (const h of alturas) expect(h).toBeGreaterThanOrEqual(44);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("a linha inteira é clicável: o clique no canto da linha, longe do título, abre a Fonte", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/acervo");
  const linha = page
    .locator('[data-slot="linha-fonte"]')
    .filter({ hasText: "Antiguidades Judaicas" });
  await expect(linha).toBeVisible();
  const caixa = await linha.boundingBox();
  expect(caixa).not.toBeNull();
  // Canto direito e baixo da linha: nenhum texto ali, só o pseudo-elemento do link.
  await linha.click({ position: { x: (caixa?.width ?? 0) - 4, y: (caixa?.height ?? 0) - 6 } });
  await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades$/);
});
