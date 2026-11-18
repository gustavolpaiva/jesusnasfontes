import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const ROTAS = ["/entrar", "/rota-que-nao-existe"] as const;

for (const rota of ROTAS) {
  test(`@varredura sem rolagem horizontal em ${rota}`, async ({ page }) => {
    await page.goto(rota);
    // Controle positivo: a casca renderizou (sem isso, "sem rolagem" mediria uma página vazia).
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Abrir menu" })).toBeVisible();
    const sobra = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sobra).toBeLessThanOrEqual(0);
  });
}

test("@varredura a página 404 devolve status 404 com o contrato de copy", async ({ page }) => {
  const resposta = await page.goto("/rota-que-nao-existe");
  expect(resposta?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
  ).toBeVisible();
  await expect(page.getByText("Este endereço não existe ou mudou.")).toBeVisible();
  const acao = page.getByRole("link", { name: "Ir para as Trilhas" });
  await expect(acao).toBeVisible();
  const caixa = await acao.boundingBox();
  expect(caixa?.height ?? 0).toBeGreaterThanOrEqual(48);
});

test("o primeiro Tab foca o link de salto e ele leva ao conteúdo", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "o Tab do Safari só percorre controles com a opção do sistema ligada",
  );
  await page.goto("/entrar");
  await page.keyboard.press("Tab");
  const salto = page.getByRole("link", { name: "Pular para o conteúdo" });
  await expect(salto).toBeFocused();
  await expect(salto).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#conteudo")).toBeFocused();
});

test("@varredura o botão de Menu tem pelo menos 44 por 44 px", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page.getByRole("button", { name: "Abrir menu" })).toBeVisible();
  const medir = async () => page.getByRole("button", { name: "Abrir menu" }).boundingBox();
  await expect.poll(async () => (await medir())?.width ?? 0).toBeGreaterThanOrEqual(44);
  expect((await medir())?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test("com o cookie tema=escuro o HTML inicial já traz data-tema=escuro", async ({ request }) => {
  const com = await request.get("/entrar", { headers: { cookie: "tema=escuro" } });
  const html = await com.text();
  expect(html).toMatch(/<html[^>]*data-tema="escuro"/);
  const sem = await request.get("/entrar");
  expect(await sem.text()).not.toMatch(/<html[^>]*data-tema=/);
  // Valor fora da lista não entra no HTML.
  const ruim = await request.get("/entrar", { headers: { cookie: 'tema=" onload=x' } });
  expect(await ruim.text()).not.toMatch(/<html[^>]*data-tema=/);
});

test("@varredura o tema escuro por preferência e por escolha pintam o mesmo fundo", async ({
  page,
  browser,
}) => {
  await page.goto("/entrar");
  const fundo = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const esquema = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
  expect(fundo).toBe(esquema ? "rgb(21, 22, 26)" : "rgb(250, 250, 247)");
  const contexto = await browser.newContext({
    baseURL: page.url().replace(/\/$/, ""),
    colorScheme: esquema ? "light" : "dark",
  });
  await contexto.addCookies([{ name: "tema", value: "escuro", url: page.url() }]);
  const outra = await contexto.newPage();
  await outra.goto("/entrar");
  expect(await outra.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
    "rgb(21, 22, 26)",
  );
  await contexto.close();
});

test("as fontes são do próprio site e carregam de verdade", async ({ page }) => {
  const externos: string[] = [];
  const origemDoSite = new URL(test.info().project.use.baseURL ?? "http://localhost").origin;
  page.on("request", (requisicao) => {
    const url = requisicao.url();
    if (
      !url.startsWith("data:") &&
      !url.startsWith("blob:") &&
      new URL(url).origin !== origemDoSite
    ) {
      externos.push(url);
    }
  });
  await page.goto("/entrar");
  await page.evaluate(() => document.fonts.ready);
  const medido = await page.evaluate(async () => {
    await document.fonts.load('600 38px "Cormorant Garamond"').catch(() => []);
    const carregadas = [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => `${f.family}|${f.weight}|${f.style}`);
    return {
      h1: getComputedStyle(document.querySelector("h1") as Element).fontFamily,
      corpo: getComputedStyle(document.body).fontFamily,
      carregadas,
    };
  });
  // O next/font/local nomeia a família pelo identificador exportado; o que importa é que a
  // primeira família do h1 e a do corpo foram carregadas (status "loaded"), não só declaradas.
  expect(medido.h1).toMatch(/^"?tipografiaExibicao"?,/);
  expect(medido.corpo).toMatch(/^"?tipografiaCorpo"?,/);
  expect(medido.carregadas.some((f) => f.startsWith("tipografiaExibicao|600"))).toBe(true);
  expect(medido.carregadas.some((f) => f.startsWith("tipografiaCorpo|"))).toBe(true);
  expect(externos).toEqual([]);
});

test("@varredura axe sem violações", async ({ page }) => {
  await page.goto("/entrar");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const resultado = await new AxeBuilder({ page }).analyze();
  expect(resultado.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});
