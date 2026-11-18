import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ultimoEmailPara } from "../../support/caixa-de-email";
import { convidarParaTeste, emailDeTeste, isolarIp, pedirAcesso } from "../../support/login-e2e";

test("um leitor automático que busca o link não o gasta; só o POST do botão consome", async ({
  page,
  request,
}) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { link } = await ultimoEmailPara(endereco);
  expect(link).not.toBeNull();

  // Cliente HTTP simples, como um leitor de e-mail: duas buscas, sem JavaScript, sem cookies.
  for (let i = 0; i < 2; i++) {
    const resposta = await request.get(link as string);
    expect(resposta.status()).toBe(200);
    const html = await resposta.text();
    expect(html).toContain("Confirmar entrada");
    expect(resposta.headers()["referrer-policy"]).toBe("no-referrer");
    expect(html).not.toContain("Este link não vale mais");
  }

  // O link continua valendo: entra no navegador (controle positivo de que nada foi consumido).
  await page.goto(link as string);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  // E vale uma vez só: o mesmo link, de novo, mostra a tela única de link inválido.
  const outra = await page.context().browser()?.newContext();
  const nova = await (outra as NonNullable<typeof outra>).newPage();
  await nova.goto(link as string);
  await nova.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    nova.getByRole("heading", { level: 1, name: "Este link não vale mais" }),
  ).toBeVisible();
  await outra?.close();
});

test("a rota crua que consome o link no GET responde 404", async ({ request }) => {
  const resposta = await request.get("/api/auth/magic-link/verify?token=qualquer");
  expect(resposta.status()).toBe(404);
});

test("a tela de link inválido é a mesma para token inexistente e para token ausente", async ({
  page,
}) => {
  await page.goto("/entrar/confirmar?token=inexistente");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Este link não vale mais" }),
  ).toBeVisible();
  const comToken = await page.locator("main").textContent();
  await page.goto("/entrar/confirmar");
  const semToken = await page.locator("main").textContent();
  expect(comToken).toBe(semToken);
  expect(comToken).toContain("Este link não vale mais");
});

test("o registro do servidor não traz o código, o endereço nem o link fora da linha de requisição do Next", async ({
  page,
}) => {
  const registro = process.env.JNF_LOG_SERVIDOR;
  test.skip(!registro, "sem JNF_LOG_SERVIDOR o servidor não grava o registro");
  const endereco = emailDeTeste("marcador-privado");
  await convidarParaTeste(endereco);
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { link, codigo } = await ultimoEmailPara(endereco);
  const token = new URL(link as string).searchParams.get("token") as string;
  expect(token.length).toBeGreaterThan(16);
  expect(codigo).toMatch(/^\d{6}$/);

  // Caminhos de erro e de sucesso: código errado, link aberto, entrada pelo link.
  await page.getByLabel("Código de 6 dígitos").fill(codigo === "000000" ? "111111" : "000000");
  await page.getByRole("button", { name: "Entrar com o código" }).click();
  await expect(page.getByText("Código inválido ou vencido.")).toBeVisible();
  await page.goto(link as string);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  const texto = readFileSync(registro as string, "utf8");
  // Controle positivo: o registro existe e traz as linhas de requisição do servidor.
  expect(existsSync(registro as string)).toBe(true);
  expect(texto).toContain("/entrar");
  // O que o código da aplicação escreve nunca traz o link: a única linha com o token é a de
  // requisição que o próprio Next imprime (`GET` e `POST /entrar/confirmar?token=… 200 in …`). Esse
  // registro da plataforma é um risco aceito e declarado (o token vale uma vez e 15 minutos).
  const linhasComToken = texto.split("\n").filter((linha) => linha.includes(token));
  expect(linhasComToken.length).toBeGreaterThan(0); // controle: o instrumento enxerga o token
  for (const linha of linhasComToken) {
    // (o Next pinta a linha com códigos de cor; por isso o teste não depende dos separadores)
    expect(linha).toMatch(/(GET|POST) \/entrar\/confirmar\?token=/);
    expect(linha).toMatch(/\d{3}/);
    expect(linha.split(token)).toHaveLength(2);
  }
  expect(texto).not.toContain(endereco);
  expect(texto).not.toContain(endereco.split("@")[0] as string);
  expect(texto).not.toContain(`sign-in-otp-`);
  expect(texto).not.toMatch(new RegExp(`(?<![0-9])${codigo}(?![0-9])`));
});
