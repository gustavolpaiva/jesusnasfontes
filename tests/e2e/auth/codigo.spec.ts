import { createHash } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { type EmailLido, emailsPara, ultimoEmailPara } from "../../support/caixa-de-email";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  isolarIp,
  pedirAcesso,
} from "../../support/login-e2e";

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

const INVALIDO = "Código inválido ou vencido. Confira os 6 dígitos ou peça um novo acesso.";

const chaveFalhas = (email: string) =>
  `codigo-falhas:${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;

// Põe o contador de falhas do endereço em `n` numa janela aberta agora (como se já houvesse n palpites).
async function semearFalhas(endereco: string, n: number) {
  const { default: pg } = await import("pg");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await c.connect();
  try {
    await c.query(
      `insert into admin.tentativa (chave, janela_inicio, contagem)
       values ($1, now(), $2)
       on conflict (chave) do update set janela_inicio = now(), contagem = $2`,
      [chaveFalhas(endereco), n],
    );
  } finally {
    await c.end();
  }
}

const falhasGravadas = (endereco: string) =>
  contar("select coalesce(sum(contagem), 0) as n from admin.tentativa where chave = $1", [
    chaveFalhas(endereco),
  ]);

async function textoDoErro(page: Page) {
  const alerta = page.getByRole("alert").filter({ hasText: "Erro." });
  await expect(alerta).toBeVisible();
  return ((await alerta.textContent()) ?? "").replace(/\s+/g, " ").trim();
}

// Roteiro: pede acesso, tem 9 falhas acumuladas, pede acesso DE NOVO (o contador não pode zerar),
// erra uma vez (10, o teto) e tenta o código que seria o certo. Devolve as mensagens.
async function roteiro(page: Page, endereco: string, certo: () => Promise<string>) {
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  await semearFalhas(endereco, 9);
  await page.getByRole("button", { name: "Usar outro e-mail" }).click();
  await pedirAcesso(page, endereco);
  const aposPedido = await falhasGravadas(endereco);
  await digitarCodigo(page, "000000");
  const m1 = await textoDoErro(page);
  await isolarIp(page);
  await digitarCodigo(page, await certo());
  const m2 = await textoDoErro(page);
  return { aposPedido, mensagens: [m1, m2] };
}

test("pedido repetido não devolve palpites; no teto o código CERTO é recusado, o link entra e o não convidado recebe as mesmas respostas", async ({
  page,
  browser,
}) => {
  const vitima = emailDeTeste();
  const desconhecido = emailDeTeste("fora");
  await convidarParaTeste(vitima);
  const a = await roteiro(page, vitima, async () => {
    const m = await ultimoEmailPara(vitima, { depoisDe: 1 });
    return m.codigo as string;
  });
  // O pedido novo não zerou o contador (controle: ele estava em 9 antes).
  expect(a.aposPedido).toBe(9);
  expect(await falhasGravadas(vitima)).toBeGreaterThanOrEqual(10);
  expect(a.mensagens[1]).toContain("Código inválido ou vencido.");
  await expect(page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" })).toBeVisible();

  // O link do primeiro e-mail não passa por esse contador e entra.
  const primeiro = emailsPara(vitima).filter((m) => /acesso/i.test(m.assunto))[0] as EmailLido;
  const ctx = await browser.newContext();
  const aba = await ctx.newPage();
  await aba.goto(primeiro.link as string);
  await aba.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(aba.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await ctx.close();

  // Endereço não convidado: a mesma sequência de mensagens, comparada diretamente.
  const outra = await browser.newContext();
  const b = await roteiro(await outra.newPage(), desconhecido, async () => "123456");
  await outra.close();
  expect(b.aposPedido).toBe(9);
  expect(b.mensagens).toEqual(a.mensagens);
});

test("um código novo invalida o anterior; o link anterior continua valendo", async ({
  page,
  browser,
}) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const antigo = await ultimoEmailPara(endereco);
  await page.getByRole("button", { name: "Usar outro e-mail" }).click();
  await pedirAcesso(page, endereco);
  const novo = await ultimoEmailPara(endereco, { depoisDe: 1 });
  test.skip(antigo.codigo === novo.codigo, "códigos iguais por acaso (1 em 1 milhão)");
  // Um código por endereço, medido no banco: o pedido novo não deixa o anterior para trás.
  expect(
    await contar("select count(*) as n from auth.verification where identifier = $1", [
      `sign-in-otp-${endereco}`,
    ]),
  ).toBe(1);

  await digitarCodigo(page, antigo.codigo as string);
  await expect(page.getByText("Código inválido ou vencido.")).toBeVisible();

  // O link do primeiro e-mail ainda entra (controle positivo de que só o código foi invalidado).
  const ctx = await browser.newContext();
  const aba = await ctx.newPage();
  await aba.goto(antigo.link as string);
  await aba.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(aba.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await ctx.close();
});

test("o código do pedido mais novo entra, e a entrada zera o contador de falhas", async ({
  page,
}) => {
  const endereco = emailDeTeste();
  await convidarParaTeste(endereco);
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { codigo } = await ultimoEmailPara(endereco);
  const errado = codigo === "000000" ? "111111" : "000000";
  await digitarCodigo(page, errado);
  await expect(page.getByText("Código inválido ou vencido.")).toBeVisible();
  expect(
    await contar("select count(*) as n from admin.tentativa where chave = $1", [
      chaveFalhas(endereco),
    ]),
  ).toBe(1);
  await digitarCodigo(page, codigo as string);
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  expect(
    await contar("select count(*) as n from admin.tentativa where chave = $1", [
      chaveFalhas(endereco),
    ]),
  ).toBe(0);
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

test("um terceiro que só sabe o e-mail esgota o código mas não cancela o link da vítima nem o de outro endereço", async ({
  page,
  browser,
}) => {
  const vitima = emailDeTeste();
  const outro = emailDeTeste("outro");
  await convidarParaTeste(vitima);
  await convidarParaTeste(outro);
  await isolarIp(page);
  await pedirAcesso(page, vitima);
  const primeiro = await ultimoEmailPara(vitima);
  const doOutro = await browser.newContext();
  const paginaOutro = await doOutro.newPage();
  await isolarIp(paginaOutro);
  await pedirAcesso(paginaOutro, outro);
  const emailOutro = await ultimoEmailPara(outro);

  // O terceiro pede acesso para o e-mail da vítima e erra o código três vezes.
  const terceiro = await browser.newContext();
  const t = await terceiro.newPage();
  await isolarIp(t);
  await pedirAcesso(t, vitima);
  await ultimoEmailPara(vitima, { depoisDe: 1 });
  const errado = primeiro.codigo === "000000" ? "111111" : "000000";
  for (let i = 0; i < 3; i++) await digitarCodigo(t, errado);
  await expect(t.getByText("Código inválido ou vencido.")).toBeVisible();
  // O código com as 3 tentativas gastas continua recusado, até o certo.
  await digitarCodigo(t, primeiro.codigo as string);
  await expect(t.getByText("Código inválido ou vencido.")).toBeVisible();
  // A resposta é a mesma de um endereço não convidado (ver teste anterior de endereço desconhecido).

  // O link que a vítima recebeu primeiro continua valendo, e o do outro endereço também.
  await page.goto(primeiro.link as string);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await paginaOutro.goto(emailOutro.link as string);
  await paginaOutro.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(paginaOutro.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await terceiro.close();
  await doOutro.close();
});
