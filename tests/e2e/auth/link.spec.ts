import { expect, test } from "@playwright/test";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

test("a pessoa convidada entra pelo link do e-mail e sai pelo Menu", async ({ page }) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await entrarPorLink(page, endereco);

  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page.getByText("Você saiu.")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Entrar" })).toBeVisible();
});
