import { expect, test } from "@playwright/test";
import { ultimoEmailPara } from "../../support/caixa-de-email";
import {
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  pedirAcesso,
  revogarConviteNoBanco,
  sessoesDe,
} from "../../support/login-e2e";

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

// Convite revogado depois de o link e o código serem pedidos: nenhuma sessão nasce para quem foi
// revogado, e quem já estava autenticado no mesmo navegador continua autenticado.
for (const via of ["link", "codigo"] as const) {
  test(`convite revogado, entrada por ${via}: nenhuma sessão é criada e a pessoa já autenticada fica`, async ({
    page,
    browser,
  }) => {
    const a = emailDeTeste("a");
    const b = emailDeTeste("b");
    await convidarParaTeste(a);
    await convidarParaTeste(b);
    await entrarPorLink(page, a);
    const sessoesA = await sessoesDe(a);
    expect(sessoesA).toBe(1);

    // Controle positivo: com o convite ativo, a entrada de B cria exatamente uma sessão.
    const c = emailDeTeste("c");
    await convidarParaTeste(c);
    const ctxOk = await browser.newContext();
    await entrarPorLink(await ctxOk.newPage(), c);
    expect(await sessoesDe(c)).toBe(1);
    await ctxOk.close();

    // B pede acesso no navegador de A (A está autenticado lá).
    await pedirAcesso(page, b);
    const email = await ultimoEmailPara(b);
    await revogarConviteNoBanco(b);

    if (via === "link") {
      await page.goto(email.link as string);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: "Este link não vale mais" }),
      ).toBeVisible();
    } else {
      await page.getByLabel("Código de 6 dígitos").fill(email.codigo as string);
      await page.getByRole("button", { name: "Entrar com o código" }).click();
      await expect(page.getByText("Código inválido ou vencido.")).toBeVisible();
    }

    expect(await sessoesDe(b)).toBe(0);
    const cookies = await page.context().cookies();
    const sessaoNoCookie = cookies.find((c) => c.name.includes("session_token"));
    // O cookie continua sendo o de A: a sessão de A segue viva no banco e vale no navegador.
    expect(sessaoNoCookie).toBeDefined();
    expect(await sessoesDe(a)).toBe(sessoesA);
    await page.goto("/trilhas");
    await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  });
}

test("sessão que sobrou de um convite revogado não vale: a pessoa cai em /entrar e a sessão é apagada", async ({
  page,
  browser,
}) => {
  const a = emailDeTeste("sobrou");
  const vizinho = emailDeTeste("sobrou-vizinho");
  await convidarParaTeste(a);
  await convidarParaTeste(vizinho);
  await entrarPorLink(page, a);
  const outro = await browser.newContext();
  const abaVizinho = await outro.newPage();
  await entrarPorLink(abaVizinho, vizinho);
  // Controle positivo: com o convite ativo, a sessão abre as Trilhas.
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  // O convite é revogado direto no banco, SEM apagar a sessão: é o estado que uma corrida entre a
  // criação da sessão e a revogação deixaria.
  await revogarConviteNoBanco(a);
  expect(await sessoesDe(a)).toBe(1);

  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/entrar/);
  expect(await sessoesDe(a)).toBe(0);

  // Controle negativo: a pessoa vizinha continua dentro.
  await abaVizinho.goto("/trilhas");
  await expect(abaVizinho.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  expect(await sessoesDe(vizinho)).toBe(1);
  await outro.close();
});

test("Sair fica à vista no Menu sem rolar, em tela baixa de notebook e de celular", async ({
  page,
}) => {
  const endereco = emailDeTeste("sair-visivel");
  await convidarParaTeste(endereco);
  await entrarPorLink(page, endereco);
  for (const tamanho of [
    { width: 1280, height: 640 },
    { width: 390, height: 560 },
  ]) {
    await page.setViewportSize(tamanho);
    await page.goto("/trilhas");
    await page.getByRole("button", { name: "Abrir menu" }).click();
    const sair = page.getByRole("button", { name: "Sair", exact: true });
    // Inteiro dentro da janela logo ao abrir: ninguém precisa descobrir que o Menu rola.
    await expect(sair).toBeInViewport({ ratio: 1 });
    // Controle: o item de cima ("Trilhas") também está à vista, ou seja, a folha abriu de fato.
    await expect(page.getByRole("link", { name: "Trilhas", exact: true }).last()).toBeInViewport();
    await page.getByRole("button", { name: "Fechar menu" }).click();
  }
});
