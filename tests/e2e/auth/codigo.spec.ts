import { expect, test } from "@playwright/test";
import { ultimoEmailPara } from "../../support/caixa-de-email";
import { convidarParaTeste, emailDeTeste, isolarIp, pedirAcesso } from "../../support/login-e2e";

async function digitarCodigo(page: import("@playwright/test").Page, codigo: string) {
  await page.getByLabel("Código de 6 dígitos").fill(codigo);
  await page.getByRole("button", { name: "Entrar com o código" }).click();
}

test("um contexto novo, sem cookie nenhum, entra com o código do e-mail", async ({ browser }) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  const contexto = await browser.newContext();
  expect(await contexto.cookies()).toHaveLength(0);
  const page = await contexto.newPage();
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { codigo } = await ultimoEmailPara(endereco);
  expect(codigo).toMatch(/^\d{6}$/);
  await digitarCodigo(page, codigo as string);
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await contexto.close();
});

test("três códigos errados esgotam o código; o certo, depois, também é recusado", async ({
  page,
}) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { codigo } = await ultimoEmailPara(endereco);
  const errado = codigo === "000000" ? "111111" : "000000";

  await digitarCodigo(page, errado);
  const invalido = page.getByText("Código inválido ou vencido.");
  await expect(invalido).toBeVisible();
  // O que foi digitado continua no campo.
  await expect(page.getByLabel("Código de 6 dígitos")).toHaveValue(errado);
  await digitarCodigo(page, errado);
  await expect(invalido).toBeVisible();
  await digitarCodigo(page, errado);
  await expect(page.getByText("Você errou o código muitas vezes.")).toBeVisible();

  await digitarCodigo(page, codigo as string);
  await expect(page.getByText("Você errou o código muitas vezes.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" })).toBeVisible();

  // Controle positivo: um novo acesso do mesmo endereço traz um código que funciona.
  await page.getByRole("button", { name: "Usar outro e-mail" }).click();
  await pedirAcesso(page, endereco);
  const novo = await ultimoEmailPara(endereco, { depoisDe: 1 });
  await digitarCodigo(page, novo.codigo as string);
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
});

test("a mensagem de código errado é igual para e-mail não convidado, inclusive ao esgotar", async ({
  page,
}) => {
  const desconhecido = emailDeTeste("fora");
  await isolarIp(page);
  await pedirAcesso(page, desconhecido);
  await digitarCodigo(page, "123456");
  await expect(page.getByText("Código inválido ou vencido.")).toBeVisible();
  await digitarCodigo(page, "123456");
  await expect(page.getByText("Código inválido ou vencido.")).toBeVisible();
  await digitarCodigo(page, "123456");
  await expect(page.getByText("Você errou o código muitas vezes.")).toBeVisible();
});

test("o reenvio fica desabilitado por 60 s com contagem visível e depois envia de novo", async ({
  page,
}) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await page.clock.install();
  await isolarIp(page);
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(endereco);
  await page.getByRole("button", { name: "Enviar acesso" }).click();
  await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();

  const reenviar = page.getByRole("button", { name: /^Enviar de novo/ });
  await expect(reenviar).toBeDisabled();
  await expect(reenviar).toContainText("Enviar de novo em");
  await page.clock.runFor(30_000);
  await expect(reenviar).toContainText(/Enviar de novo em (2[89]|30|31) s/);
  await page.clock.runFor(31_000);
  await expect(reenviar).toBeEnabled();
  await expect(reenviar).toHaveText("Enviar de novo");

  await reenviar.click();
  await expect(
    page.getByText("Se este e-mail foi convidado, enviamos o acesso de novo."),
  ).toBeVisible();
  const segundo = await ultimoEmailPara(endereco, { depoisDe: 1 });
  expect(segundo.codigo).toMatch(/^\d{6}$/);
  // Depois de reenviar, a contagem recomeça.
  await expect(page.getByRole("button", { name: /^Enviar de novo em/ })).toBeDisabled();
});

test("os limites de pedido mostram a mesma mensagem para qualquer e-mail", async ({ page }) => {
  const convidado = emailDeTeste();
  const desconhecido = emailDeTeste("fora");
  await convidarParaTeste(convidado);
  await isolarIp(page);
  // Controle positivo: os três primeiros pedidos passam, para os dois tipos.
  for (const endereco of [convidado, desconhecido]) {
    await page.goto("/entrar");
    for (let i = 0; i < 3; i++) {
      await page.getByLabel("E-mail").fill(endereco);
      await page.getByRole("button", { name: "Enviar acesso" }).click();
      await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
      await page.getByRole("button", { name: "Usar outro e-mail" }).click();
    }
    await page.getByLabel("E-mail").fill(endereco);
    await page.getByRole("button", { name: "Enviar acesso" }).click();
    await expect(
      page.getByText("Muitas tentativas em pouco tempo. Espere um minuto e tente de novo."),
    ).toBeVisible();
    // O que foi digitado continua no campo.
    await expect(page.getByLabel("E-mail")).toHaveValue(endereco);
    await isolarIp(page);
  }
});
