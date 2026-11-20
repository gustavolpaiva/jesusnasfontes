import type { Page } from "@playwright/test";
import { emailDeTeste, entrarPorLink, semearAdminParaTeste } from "./login-e2e";
import { gerarTotp } from "./totp";

// Admin completo para os testes: semeia a conta (já com o aceite do aviso, por `semearAdminParaTeste`),
// entra pelo link, cadastra o autenticador com o código calculado da chave que a tela mostra, guarda
// os códigos de recuperação e chega à Administração. Reusa os helpers do 01-08 e do 01-14; só junta o
// que `admin-mfa.spec.ts` fazia em função local.
export type AdminDeTeste = { endereco: string; chave: string };

export async function entrarComoAdmin(page: Page, prefixo = "admin"): Promise<AdminDeTeste> {
  const endereco = emailDeTeste(prefixo);
  await semearAdminParaTeste(endereco);
  await entrarPorLink(page, endereco, "Ative o segundo fator");
  const chave = (await page.getByTestId("chave").innerText()).replace(/\s/g, "");
  await page.getByLabel("Código de 6 dígitos").fill(gerarTotp(chave));
  await page.getByRole("button", { name: "Ativar" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" })
    .waitFor();
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await page.getByRole("heading", { level: 1, name: "Administração" }).waitFor();
  return { endereco, chave };
}
