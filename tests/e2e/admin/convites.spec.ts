import { expect, test } from "@playwright/test";
import { emailsPara } from "../../support/caixa-de-email";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import { contar, convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Convites pela tela (AUTH-01): o Admin convida e vê o convite Pendente; ninguém mais alcança a tela.

test("Admin convida pela tela, vê o convite Pendente e o e-mail de convite sai sem link de entrada", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  await expect(page.getByRole("heading", { level: 1, name: "Convites" })).toBeVisible();
  // Controle: antes de convidar, só existe o convite do próprio Admin.
  await expect(page.getByRole("heading", { level: 2, name: /^Convidados \(\d+\)$/ })).toBeVisible();

  const convidado = emailDeTeste("convidado");
  await page.getByLabel("E-mail da pessoa").fill(convidado);
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText(`Convite registrado e enviado para ${convidado}.`)).toBeVisible();

  const linha = page.getByRole("listitem").filter({ hasText: convidado });
  await expect(linha.getByText("Pendente", { exact: true })).toBeVisible();
  await expect(page.getByLabel("E-mail da pessoa")).toHaveValue("");

  // O e-mail de convite chegou ao transporte em arquivo e não traz link de entrada.
  const emails = emailsPara(convidado).filter((m) => /convite/i.test(m.assunto));
  expect(emails).toHaveLength(1);
  expect(emails[0]?.texto).not.toContain("/entrar/confirmar");
  expect(emails[0]?.link).toBeNull();
});

test("convite duplicado e e-mail malformado mostram o texto do contrato e mantêm o que foi digitado", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const campo = page.getByLabel("E-mail da pessoa");

  await campo.fill("sem-arroba");
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(
    page.getByText("Esse e-mail parece incompleto. Confira e tente de novo."),
  ).toBeVisible();
  await expect(campo).toHaveValue("sem-arroba");

  const convidado = emailDeTeste("duplicado");
  await campo.fill(convidado);
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText(`Convite registrado e enviado para ${convidado}.`)).toBeVisible();
  await campo.fill(convidado.toUpperCase());
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText("Este e-mail já tem convite. Use Reenviar na lista.")).toBeVisible();
  await expect(campo).toHaveValue(convidado.toUpperCase());
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [convidado]),
  ).toBe(1);
  expect(emailsPara(convidado).filter((m) => /convite/i.test(m.assunto))).toHaveLength(1);
});

test("Estudante comum recebe a 404 em /admin/convites e a ação de convidar recusa no servidor", async ({
  browser,
  page,
}) => {
  // O Admin dispara a ação de verdade e a requisição é capturada para ser repetida pelo Estudante.
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const pedido = page.waitForRequest((r) => r.method() === "POST" && !!r.headers()["next-action"]);
  await page.getByLabel("E-mail da pessoa").fill(emailDeTeste("controle"));
  await page.getByRole("button", { name: "Convidar" }).click();
  const acaoReal = await pedido;
  await expect(page.getByText(/Convite registrado e enviado para/)).toBeVisible();

  const estudante = emailDeTeste("estudante");
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  await aba.goto("/admin/convites");
  await expect(aba.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();

  // Mesma requisição, agora com o cookie do Estudante: nada é criado.
  const alvo = emailDeTeste("invasor");
  const cabecalhos: Record<string, string> = {
    ...acaoReal.headers(),
    origin: new URL(acaoReal.url()).origin,
  };
  delete cabecalhos.cookie;
  delete cabecalhos["content-length"];
  delete cabecalhos["content-type"];
  const corpo = acaoReal.postDataBuffer()?.toString("latin1") ?? "";
  // O corpo é multipart; o endereço do convite do Admin é trocado pelo do invasor.
  const trocado = corpo.replace(/controle-[0-9a-f]+@convite\.example/, alvo);
  expect(trocado).toContain(alvo);
  const resposta = await contexto.request.post(new URL(acaoReal.url()).pathname, {
    headers: { ...cabecalhos, "content-type": acaoReal.headers()["content-type"] ?? "" },
    data: Buffer.from(trocado, "latin1"),
    maxRedirects: 0,
  });
  expect(resposta.status()).toBe(404);
  // Controle positivo: a mesma requisição adulterada, com o cookie do Admin, é processada.
  const comoAdmin = emailDeTeste("controle-admin");
  const respostaAdmin = await page.context().request.post(new URL(acaoReal.url()).pathname, {
    headers: { ...cabecalhos, "content-type": acaoReal.headers()["content-type"] ?? "" },
    data: Buffer.from(corpo.replace(/controle-[0-9a-f]+@convite\.example/, comoAdmin), "latin1"),
    maxRedirects: 0,
  });
  expect(respostaAdmin.status()).toBe(200);
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [comoAdmin]),
  ).toBe(1);
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [alvo]),
  ).toBe(0);
  expect(emailsPara(alvo)).toHaveLength(0);
});
