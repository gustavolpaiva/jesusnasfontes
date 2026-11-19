import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  isolarIp,
  semearAdminParaTeste,
} from "../../support/login-e2e";
import { gerarTotp } from "../../support/totp";

// Segundo fator do Admin (AUTH-08). Cada teste semeia o próprio Admin (endereço sob domínio
// reservado) no banco da execução; os limites por conta, então, não se misturam entre testes.

type Cadastro = { endereco: string; chave: string; codigos: string[] };

const PASSO = 30_000;

async function lerChave(page: Page): Promise<string> {
  const texto = await page.getByTestId("chave").innerText();
  return texto.replace(/\s/g, "");
}

// Admin novo entra pelo link, vê o cadastro, ativa com o código calculado e guarda os códigos.
async function cadastrarAdmin(page: Page, prefixo = "admin"): Promise<Cadastro> {
  const endereco = emailDeTeste(prefixo);
  await semearAdminParaTeste(endereco);
  await entrarPorLink(page, endereco, "Ative o segundo fator");
  const chave = await lerChave(page);
  await page.getByLabel("Código de 6 dígitos").fill(gerarTotp(chave));
  await page.getByRole("button", { name: "Ativar" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" })
    .waitFor();
  const codigos = (await page.getByTestId("codigos").locator("li").allInnerTexts()).map((c) =>
    c.trim(),
  );
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await page.getByRole("heading", { level: 1, name: "Administração" }).waitFor();
  return { endereco, chave, codigos };
}

// Contexto novo (outro aparelho) que entra de novo pelo link e cai na verificação.
async function novoAparelho(browser: Browser, endereco: string) {
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, endereco, "Segundo fator");
  return { contexto, aba };
}

test("Admin entra pelo link, é barrado em toda rota, cadastra o autenticador e só então chega à administração", async ({
  page,
  browser,
}) => {
  const endereco = emailDeTeste("admin");
  await semearAdminParaTeste(endereco);
  await entrarPorLink(page, endereco, "Ative o segundo fator");
  await expect(page).toHaveURL(/\/admin\/segundo-fator$/);

  // Antes de verificar: nenhuma página abre.
  for (const rota of ["/trilhas", "/admin", "/"]) {
    await page.goto(rota);
    await expect(page, rota).toHaveURL(/\/admin\/segundo-fator$/);
  }

  // O QR é um ladrilho branco com nome acessível; a chave é lida da tela.
  const ladrilho = page.getByRole("img", { name: "Código QR para o aplicativo autenticador" });
  await expect(ladrilho).toBeVisible();
  const chave = await lerChave(page);
  expect(chave).toMatch(/^[A-Z2-7]{40,64}$/);

  // Código errado não ativa (controle negativo ao lado do positivo).
  const certo = gerarTotp(chave);
  const errado = certo === "000000" ? "000001" : "000000";
  await page.getByLabel("Código de 6 dígitos").fill(errado);
  await page.getByRole("button", { name: "Ativar" }).click();
  await expect(page.getByText("Código incorreto.")).toBeVisible();
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/admin\/segundo-fator$/);

  // Recarregar a página mostra a MESMA chave (o aplicativo já escaneado continua valendo).
  expect(await lerChave(page)).toBe(chave);

  await page.getByLabel("Código de 6 dígitos").fill(certo);
  await page.getByRole("button", { name: "Ativar" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" }),
  ).toBeVisible();
  const codigos = await page.getByTestId("codigos").locator("li").allInnerTexts();
  expect(codigos).toHaveLength(10);

  // Sem a caixa marcada, o envio leva o foco a ela e mostra o erro.
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page.getByText("Marque a caixa depois de guardar os códigos.")).toBeVisible();
  await expect(page.getByLabel("Guardei os códigos em um lugar seguro.")).toBeFocused();
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Convites" }).first()).toBeVisible();

  // Depois de verificar, as páginas abrem (controle positivo do bloqueio acima).
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  // Estudante comum: a área não existe (mesma 404), nas duas rotas.
  const estudante = emailDeTeste("estudante");
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  for (const rota of ["/admin", "/admin/segundo-fator"]) {
    await aba.goto(rota);
    await expect(
      aba.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeVisible();
  }
  await contexto.close();
  await isolarIp(page);
});
