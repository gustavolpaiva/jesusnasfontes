import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const PAGINA = "/casca-teste";

async function abrirMenu(page: Page) {
  await page.goto(PAGINA);
  await page.getByRole("button", { name: "Abrir menu" }).click();
  const folha = page.getByRole("dialog", { name: "Menu" });
  await expect(folha).toBeVisible();
  // Controle positivo: a seção Aparência existe dentro da folha.
  await expect(folha.getByRole("heading", { name: "Aparência" })).toBeVisible();
  return folha;
}

const cookiesDe = async (page: Page) =>
  Object.fromEntries((await page.context().cookies()).map((c) => [c.name, c.value]));

test("escolher Escuro grava o cookie e o tema persiste depois de recarregar; Do aparelho apaga", async ({
  page,
}) => {
  const folha = await abrirMenu(page);
  await folha.getByRole("radio", { name: "Escuro" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-tema", "escuro");
  await expect.poll(async () => (await cookiesDe(page)).tema).toBe("escuro");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-tema", "escuro");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    "rgb(21, 22, 26)",
  );

  await page.getByRole("button", { name: "Abrir menu" }).click();
  const outra = page.getByRole("dialog", { name: "Menu" });
  await expect(outra.getByRole("radio", { name: "Escuro" })).toBeChecked();
  await outra.getByRole("radio", { name: "Do aparelho" }).click();
  await expect.poll(async () => (await cookiesDe(page)).tema).toBeUndefined();
  await expect(page.locator("html")).not.toHaveAttribute("data-tema", /.*/);
});

test("A+ até o passo 5 muda a escala sem recarregar e desabilita o A+ no extremo", async ({
  page,
}) => {
  const folha = await abrirMenu(page);
  await page.evaluate(() => {
    (window as unknown as { marca: number }).marca = 1;
  });
  const escala = () =>
    page.evaluate(() => document.documentElement.style.getPropertyValue("--escala-texto"));
  expect(await escala()).toBe("1");
  const aumentar = folha.getByRole("button", { name: "Aumentar texto" });
  const tamanhoDaAmostra = () =>
    page
      .getByTestId("amostra-de-texto")
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
  const antes = await tamanhoDaAmostra();
  for (let i = 0; i < 3; i++) await aumentar.click();
  expect(await escala()).toBe("1.5");
  await expect(aumentar).toHaveAttribute("aria-disabled", "true");
  await expect(folha.getByText("5 de 5", { exact: true })).toBeVisible();
  expect(await tamanhoDaAmostra()).toBeCloseTo(antes * 1.5, 0);
  // Mais um clique no extremo não faz nada (o Playwright trata aria-disabled como desabilitado).
  await aumentar.click({ force: true });
  expect(await escala()).toBe("1.5");
  // Sem recarregar: a marca da página continua.
  expect(await page.evaluate(() => (window as unknown as { marca?: number }).marca)).toBe(1);
  await expect.poll(async () => (await cookiesDe(page))["escala-texto"]).toBe("5");
  // O texto de leitura da página atrás da folha também cresceu; o título não.
  const fontes = await page.evaluate(() => ({
    leitura: Number.parseFloat(
      getComputedStyle(document.querySelector("main p") as Element).fontSize,
    ),
    titulo: Number.parseFloat(
      getComputedStyle(document.querySelector("main h1") as Element).fontSize,
    ),
  }));
  expect(fontes.leitura).toBeCloseTo(28.5, 0);
  expect(fontes.titulo).toBeCloseTo(38, 0);

  await folha.getByRole("button", { name: "Voltar ao padrão" }).click();
  expect(await escala()).toBe("1");
  await expect(folha.getByText("Padrão", { exact: true })).toBeVisible();
});

test("o cookie escala-texto vale no HTML inicial e valor fora da lista é ignorado", async ({
  request,
}) => {
  const com = await request.get(PAGINA, { headers: { cookie: "escala-texto=5" } });
  expect(await com.text()).toMatch(/<html[^>]*--escala-texto:\s*1\.5/);
  const ruim = await request.get(PAGINA, { headers: { cookie: "escala-texto=99" } });
  expect(await ruim.text()).toMatch(/<html[^>]*--escala-texto:\s*1[;"]/);
});

test("@varredura passo 5: sem rolagem horizontal e navegação de quatro itens sem corte", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: "escala-texto", value: "5", url: baseURL ?? "http://localhost" },
  ]);
  await page.goto(PAGINA);
  await expect(page.getByRole("heading", { level: 1, name: "Casca de teste" })).toBeVisible();
  const sobra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sobra).toBeLessThanOrEqual(0);

  const largura = page.viewportSize()?.width ?? 0;
  // Até 1023 px a navegação é a faixa inferior; de 1024 px em diante, os links do cabeçalho.
  const navegacao = page.getByRole("navigation", { name: "Seções" });
  await expect(navegacao).toHaveCount(1);
  const links = navegacao.getByRole("link");
  await expect(links).toHaveCount(4);
  const medidas = await links.evaluateAll((els) =>
    els.map((el) => ({
      altura: el.getBoundingClientRect().height,
      cortado: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
    })),
  );
  for (const m of medidas) {
    expect(m.altura).toBeGreaterThanOrEqual(largura < 1024 ? 60 : 44);
    expect(m.cortado).toBe(false);
  }
});

test("Esc fecha o Menu e o foco volta ao botão que abriu", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "o foco do Safari por clique não segue a regra de teclado");
  const folha = await abrirMenu(page);
  await page.keyboard.press("Escape");
  await expect(folha).toBeHidden();
  await expect(page.getByRole("button", { name: "Abrir menu" })).toBeFocused();
});

test("com movimento reduzido a abertura da folha não anima", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const folha = await abrirMenu(page);
  const duracao = await folha.evaluate((el) => {
    const c = getComputedStyle(el);
    const paraMs = (v: string) =>
      Math.max(
        ...v.split(",").map((t) => Number.parseFloat(t) * (t.trim().endsWith("ms") ? 1 : 1000)),
      );
    return { animacao: paraMs(c.animationDuration), transicao: paraMs(c.transitionDuration) };
  });
  expect(duracao.animacao).toBeLessThanOrEqual(0.01 + 1e-6);
  expect(duracao.transicao).toBeLessThanOrEqual(0.01 + 1e-6);
});

test("axe sem violações com o Menu aberto", async ({ page }) => {
  await abrirMenu(page);
  const resultado = await new AxeBuilder({ page }).analyze();
  expect(resultado.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test("@varredura a casca de teste passa no axe com a navegação", async ({ page }) => {
  await page.goto(PAGINA);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const resultado = await new AxeBuilder({ page }).analyze();
  expect(resultado.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});
