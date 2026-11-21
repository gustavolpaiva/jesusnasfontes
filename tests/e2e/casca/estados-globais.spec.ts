import { expect, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Estados globais do contrato (tela 16), achados na varredura do plano 01-19.

test("sem conexão a faixa avisa no topo do conteúdo; ao voltar, vira 'Conexão de volta.'", async ({
  page,
  context,
}) => {
  await page.goto("/entrar");
  await esperarHidratado(page.getByRole("button", { name: "Abrir menu" }));
  const faixa = page.locator("main").getByRole("status").first();
  await expect(faixa).not.toContainText("Sem conexão.");
  await context.setOffline(true);
  await expect(faixa).toContainText(
    "Sem conexão. Sua Anotação continua sendo guardada neste aparelho. O resto precisa de internet.",
  );
  await context.setOffline(false);
  await expect(faixa).toContainText("Conexão de volta.");
});

test("a página não encontrada de quem está logado não repete o cabeçalho nem o conteúdo principal", async ({
  page,
}) => {
  const email = emailDeTeste("nf");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  await page.goto("/estudos/nao-existe-mesmo");
  await expect(
    page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
  ).toBeVisible();
  // Uma casca só: um conteúdo principal, um cabeçalho, um link de salto, um rodapé.
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.getByRole("banner")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Pular para o conteúdo" })).toHaveCount(1);
  await expect(page.getByRole("contentinfo")).toHaveCount(1);
});
