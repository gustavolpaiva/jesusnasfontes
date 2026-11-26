import { type Browser, expect, type Request, test } from "@playwright/test";
import { ultimoEmailPara } from "../../support/caixa-de-email";
import { convidarParaTeste, emailDeTeste, isolarIp, pedirAcesso } from "../../support/login-e2e";

// Formulário enviado ANTES da hidratação (rede lenta, script ainda não chegou, ou sem JavaScript): o navegador faz o POST do próprio formulário, não o
// `fetch` do React. Nesse caso a política de referência do site decide o cabeçalho `Origin`: com `no-referrer` o
// navegador manda `Origin: null` num POST de formulário (Fetch, "serializar a origem do pedido"), e o Next recusa a
// Server Action ("`x-forwarded-host` header … does not match `origin` header with value `null`", "Invalid Server
// Actions request") — a pessoa que toca no botão antes de a página ficar pronta, ou que está sem JavaScript, não
// consegue entrar. Era a falha intermitente do segundo fator e de `/entrar` na suíte sob carga (plano 02-24).
// A política `same-origin` não manda Referer a ninguém de fora, e o POST do próprio site leva a origem verdadeira.

// Um contexto em que os scripts do aplicativo nunca chegam: a página aparece (o HTML é servido), mas o React não liga
// nenhum formulário. É o que o navegador de uma pessoa vive entre o primeiro pixel e a hidratação, só que parado ali.
async function contextoSemHidratacao(browser: Browser, baseURL: string) {
  const contexto = await browser.newContext({ baseURL });
  await contexto.route(/\/_next\/static\/.*\.js(\?.*)?$/, (rota) => rota.abort());
  return contexto;
}

test("o formulário de entrada, enviado antes da hidratação, chega com a origem do site e a ação roda", async ({
  browser,
  baseURL,
}) => {
  const endereco = emailDeTeste("sem-js");
  await convidarParaTeste(endereco);
  const contexto = await contextoSemHidratacao(browser, baseURL as string);
  const page = await contexto.newPage();
  await isolarIp(page);
  const posts: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") posts.push(r);
  });
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(endereco);
  await page.getByRole("button", { name: "Enviar acesso" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" })).toBeVisible();
  expect(posts).toHaveLength(1);
  const envio = posts[0] as Request;
  const cabecalhos = await envio.allHeaders();
  expect(cabecalhos.origin).toBe(new URL(baseURL as string).origin);
  const resposta = await envio.response();
  expect(resposta?.status()).toBe(200);
  const { link } = await ultimoEmailPara(endereco);
  expect(link).not.toBeNull();
  await contexto.close();
});

test("a tela de confirmar o link, enviada antes da hidratação, entra", async ({
  browser,
  baseURL,
  page,
}) => {
  const endereco = emailDeTeste("sem-js-link");
  await convidarParaTeste(endereco);
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { link } = await ultimoEmailPara(endereco);
  expect(link).not.toBeNull();

  const contexto = await contextoSemHidratacao(browser, baseURL as string);
  const semJs = await contexto.newPage();
  await semJs.goto(link as string);
  await semJs.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(semJs.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await contexto.close();
});

// O que `no-referrer` protegia continua protegido: a página de confirmar traz o token no endereço, e a navegação para
// outro site (aqui um endereço de terceiro interceptado, sem rede) não leva Referer.
test("a navegação para outro site não leva Referer, nem da tela com o token no endereço", async ({
  page,
}) => {
  let referer: string | undefined = "nunca chegou";
  await page.route("https://terceiro.example/**", async (rota) => {
    referer = rota.request().headers().referer;
    await rota.fulfill({ status: 200, contentType: "text/html", body: "<p>terceiro</p>" });
  });
  await page.goto("/entrar/confirmar?token=valor-de-teste");
  await expect(page.getByRole("heading", { level: 1, name: "Confirmar entrada" })).toBeVisible();
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.href = "https://terceiro.example/x";
    document.body.append(a);
    a.click();
  });
  await expect(page.getByText("terceiro", { exact: true })).toBeVisible();
  expect(referer).toBeUndefined();
});

// A busca do Acervo não é uma Server Action nativa: enviada antes da hidratação, a busca se perderia sem aviso. O botão "Buscar" fica desabilitado até a
// página hidratar (revisão cruzada da fase, plano 02-24), e Enter no campo não envia. Controle positivo: com os scripts, o botão habilita e a busca roda.
for (const rota of ["/acervo", "/acervo/busca"]) {
  test(`${rota}: o botão Buscar fica desabilitado antes da hidratação e habilita depois`, async ({
    browser,
    baseURL,
    page,
  }) => {
    const endereco = emailDeTeste("sem-js-busca");
    await convidarParaTeste(endereco);
    await isolarIp(page);
    await pedirAcesso(page, endereco);
    const { link } = await ultimoEmailPara(endereco);
    await page.goto(link as string);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

    const semScripts = await contextoSemHidratacao(browser, baseURL as string);
    await semScripts.addCookies(await page.context().cookies());
    const parada = await semScripts.newPage();
    const posts: string[] = [];
    parada.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await parada.goto(rota);
    const botao = parada.getByRole("button", { name: "Buscar", exact: true });
    await expect(botao).toBeDisabled();
    await parada.getByRole("searchbox", { name: "Buscar no Acervo" }).fill("pilatos");
    await parada.getByRole("searchbox", { name: "Buscar no Acervo" }).press("Enter");
    await parada.waitForTimeout(500);
    expect(posts, "nenhum POST nativo saiu").toEqual([]);
    await semScripts.close();

    await page.goto(rota);
    await expect(page.getByRole("button", { name: "Buscar", exact: true })).toBeEnabled();
  });
}
