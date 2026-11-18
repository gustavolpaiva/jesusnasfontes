import { expect, test } from "@playwright/test";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

test("a sessão persiste num contexto novo com o estado salvo, e Sair a encerra", async ({
  page,
  browser,
}) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await entrarPorLink(page, endereco);

  // O cookie de sessão é persistente e fechado ao JavaScript.
  const cookies = await page.context().cookies();
  const sessao = cookies.find((c) => c.name.includes("session_token"));
  expect(sessao).toBeDefined();
  expect(sessao?.httpOnly).toBe(true);
  expect(sessao?.sameSite).toBe("Lax");
  const diasRestantes = ((sessao?.expires ?? 0) - Date.now() / 1000) / 86400;
  expect(diasRestantes).toBeGreaterThan(25);
  expect(diasRestantes).toBeLessThanOrEqual(31);

  const estado = await page.context().storageState();

  // "Reabrir o navegador": contexto novo com o estado salvo continua autenticado.
  const reaberto = await browser.newContext({ storageState: estado });
  const aba = await reaberto.newPage();
  await aba.goto("/trilhas");
  await expect(aba.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  // Sair pelo Menu, a partir da página aberta lá.
  await aba.getByRole("button", { name: "Abrir menu" }).click();
  await aba.getByRole("button", { name: "Sair" }).click();
  await expect(aba.getByText("Você saiu.")).toBeVisible();
  const lida = await aba.request.get("/api/auth/get-session");
  expect(await lida.json()).toBeNull();

  // A sessão acabou no servidor: o estado salvo antes de sair deixa de valer (revogada, não só
  // apagada do navegador). Controle: a primeira aba ainda tinha o cookie e agora é recusada.
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
  await reaberto.close();
});
