import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { ultimoEmailPara } from "../../support/caixa-de-email";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
  lerTexto,
} from "../../support/login-e2e";

// Exportar e apagar sem aceitar o aviso (decisão do dono, 20/11/2026): quem nunca aceitou, ou tem só o
// aceite de uma versão antiga, leva os dados e apaga a conta numa casca SEM navegação. O resto do app
// continua fechado até o aceite.

const usuarios = (id: string) =>
  contar('select count(*) as n from auth."user" where id = $1', [id]);
const anotacoes = (id: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]);
const aceites = (id: string) =>
  contar("select count(*) as n from privado.consentimento where estudante_id = $1", [id]);

async function semearAnotacao(id: string, marcador: string): Promise<void> {
  await escrever(
    "insert into privado.anotacao (estudante_id, estudo_id, corpo) values ($1, gen_random_uuid(), $2)",
    [id, `corpo ${marcador}`],
  );
}

async function entrarSemAceite(page: Page, prefixo = "sem-aceite", versaoAntiga = false) {
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email, { semConsentimento: true });
  const id = await idDoUsuario(email);
  if (versaoAntiga) {
    await escrever(
      "insert into privado.consentimento (estudante_id, versao_aviso, texto_hash) values ($1, '0', 'antigo')",
      [id],
    );
  }
  await entrarPorLink(page, email, "Antes de começar");
  return { email, id };
}

const botaoApagar = (page: Page) =>
  page.getByRole("button", { name: "Apagar minha conta" }).first();
const dialogo = (page: Page) => page.getByRole("alertdialog");

async function abrirDialogo(page: Page): Promise<void> {
  await page.goto("/privacidade/seus-dados");
  await expect(async () => {
    await botaoApagar(page).click();
    await expect(dialogo(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

async function baixar(page: Page): Promise<string> {
  const botao = page.getByRole("button", { name: "Baixar meus dados" });
  await expect(botao).toBeVisible();
  let download: import("@playwright/test").Download | undefined;
  await expect(async () => {
    const espera = page.waitForEvent("download", { timeout: 1500 });
    await botao.click();
    download = await espera;
  }).toPass();
  expect(download?.suggestedFilename()).toBe("jesus-nas-fontes-meus-dados.json");
  return readFileSync((await download?.path()) as string, "utf8");
}

test("do aviso, o link leva a Seus dados, sem navegação, e o resto do app segue fechado", async ({
  page,
}) => {
  await entrarSemAceite(page);
  await page.getByRole("link", { name: "Baixar ou apagar meus dados sem aceitar" }).click();
  await expect(page).toHaveURL(/\/privacidade\/seus-dados$/);
  await expect(page.getByRole("heading", { level: 1, name: "Seus dados" })).toBeVisible();
  for (const h of ["Exportar meus dados", "Apagar minha conta"]) {
    await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  }
  // A mesma casca do aviso: só a marca e o Menu (Aparência e Sair), nenhuma navegação do app.
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await expect(page.getByRole("link", { name: "Trilhas" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Caderno" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
  await page.keyboard.press("Escape");
  // O resto continua levando ao aviso, inclusive a Conta; voltar ao aviso é um link da própria tela.
  for (const rota of ["/trilhas", "/estudos/batismo-e-tentacao", "/conta"]) {
    await page.goto(rota);
    await expect(page, rota).toHaveURL(/\/privacidade\/aceitar$/);
  }
  await page.goto("/privacidade/seus-dados");
  await page.getByRole("link", { name: "Voltar ao aviso" }).click();
  await expect(page).toHaveURL(/\/privacidade\/aceitar$/);
});

test("nunca aceitou: baixa só os próprios dados e nada é gravado pelo caminho", async ({
  page,
  request,
}) => {
  const a = await entrarSemAceite(page, "sem-aceite-exporta-a");
  const outra = emailDeTeste("sem-aceite-exporta-b");
  await convidarParaTeste(outra);
  const idB = await idDoUsuario(outra);
  await semearAnotacao(a.id, `MARCADOR-A-${a.id}`);
  await semearAnotacao(idB, `MARCADOR-B-${idB}`);

  await page.goto("/privacidade/seus-dados");
  const bruto = await baixar(page);
  const dados = JSON.parse(bruto) as {
    perfil: { email: string };
    tabelas: Record<string, unknown[]>;
  };
  expect(dados.perfil.email).toBe(a.email);
  expect(bruto).toContain(`MARCADOR-A-${a.id}`);
  expect(bruto).not.toContain(`MARCADOR-B-${idB}`);
  expect(bruto).not.toContain(outra);
  // Nunca aceitou: o arquivo não traz aceite, e baixar não cria um.
  expect(dados.tabelas.consentimento).toHaveLength(0);
  expect(await aceites(a.id)).toBe(0);

  // A rota do arquivo também responde direto (anexo, sem cache) e continua exigindo sessão.
  const resposta = await page.request.get("/conta/exportar");
  expect(resposta.status()).toBe(200);
  expect(resposta.headers()["cache-control"]).toBe("no-store");
  expect(resposta.headers()["content-disposition"]).toContain("attachment");
  const anonimo = await request.get("/conta/exportar", { maxRedirects: 0 });
  expect(anonimo.status()).toBeGreaterThanOrEqual(300);
  expect(anonimo.status()).toBeLessThan(400);
  expect(anonimo.headers().location).toContain("/entrar");
});

test("nunca aceitou: apagar com APAGAR leva a conta, a vizinha fica inteira", async ({ page }) => {
  const a = await entrarSemAceite(page, "sem-aceite-apaga-a");
  const outra = emailDeTeste("sem-aceite-apaga-b");
  await convidarParaTeste(outra);
  const idB = await idDoUsuario(outra);
  await semearAnotacao(a.id, `MARCADOR-A-${a.id}`);
  await semearAnotacao(idB, `MARCADOR-B-${idB}`);

  await abrirDialogo(page);
  const d = dialogo(page);
  await expect(d.getByRole("button", { name: "Cancelar" })).toBeFocused();
  // Sem a palavra, nada é apagado.
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(d.getByText("Digite APAGAR, em letras maiúsculas, para confirmar.")).toBeVisible();
  expect(await usuarios(a.id)).toBe(1);
  await d.getByLabel("Digite APAGAR").fill("APAGAR");
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(page).toHaveURL(/\/entrar\?apagada=1$/);
  await expect(page.getByText("Sua conta foi apagada.")).toBeVisible();

  expect(await usuarios(a.id)).toBe(0);
  expect(await anotacoes(a.id)).toBe(0);
  expect(await contar("select count(*) as n from auth.session where user_id = $1", [a.id])).toBe(0);
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [a.email]),
  ).toBe(0);
  // Controle negativo: a conta vizinha ficou inteira, com o aceite dela.
  expect(await usuarios(idB)).toBe(1);
  expect(await anotacoes(idB)).toBe(1);
  expect(await aceites(idB)).toBe(1);
  await page.goto("/conta");
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
});

test("aceite de versão antiga e sessão antiga: exporta com o aceite antigo; apaga só com o código certo", async ({
  page,
}) => {
  const { email, id } = await entrarSemAceite(page, "sem-aceite-antiga", true);
  await semearAnotacao(id, `MARCADOR-${id}`);
  await escrever(
    "update auth.session set created_at = now() - interval '1 hour' where user_id = $1",
    [id],
  );
  // O portão segue de pé: com o aceite antigo o resto leva ao aviso, que diz que ele mudou.
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/privacidade\/aceitar$/);
  await expect(page.getByText("O aviso mudou. Leia de novo e confirme.")).toBeVisible();

  await page.goto("/privacidade/seus-dados");
  const dados = JSON.parse(await baixar(page)) as { tabelas: Record<string, unknown[]> };
  expect(dados.tabelas.consentimento).toHaveLength(1);
  expect(await aceites(id)).toBe(1);

  await abrirDialogo(page);
  const d = dialogo(page);
  await expect(
    d.getByText(
      `Por segurança, confirme que é você. Enviamos um código de 6 dígitos para ${email}.`,
    ),
  ).toBeVisible();
  const mensagem = await ultimoEmailPara(email, { assunto: /apagar sua conta/i });
  const codigo = /: (\d{6})/.exec(mensagem.texto)?.[1] as string;
  await d.getByLabel("Digite APAGAR").fill("APAGAR");
  const errado = codigo === "000000" ? "111111" : "000000";
  await d.getByLabel("Código de 6 dígitos").fill(errado);
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(d.getByText(/Código inválido ou vencido/)).toBeVisible();
  expect(await usuarios(id)).toBe(1);
  await d.getByLabel("Código de 6 dígitos").fill(codigo);
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(page).toHaveURL(/\/entrar\?apagada=1$/);
  expect(await usuarios(id)).toBe(0);
  expect(await anotacoes(id)).toBe(0);
  expect(await aceites(id)).toBe(0);
});

test("quem já aceitou a versão atual vai de Seus dados à Conta", async ({ page }) => {
  const email = emailDeTeste("sem-aceite-ja-aceitou");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  await page.goto("/privacidade/seus-dados");
  await expect(page).toHaveURL(/\/conta$/);
  await expect(page.getByRole("heading", { level: 1, name: "Conta" })).toBeVisible();
});

test("o que a exceção não abre: a ação de progresso continua recusando sem aceite", async ({
  page,
}) => {
  const email = emailDeTeste("sem-aceite-progresso");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  const id = await idDoUsuario(email);
  const slug = await lerTexto("select slug as t from conteudo.estudo order by ordem limit 1");
  await page.goto(`/estudos/${slug}`);
  const concluir = page.getByRole("button", { name: "Marcar como concluído" });
  await expect(concluir).toBeVisible();
  await page.waitForLoadState("networkidle");

  // O aceite vale só para a versão atual: com ele trocado por um antigo, a página aberta ainda mostra
  // o botão, mas a ação no servidor já não obedece.
  await escrever("update privado.consentimento set versao_aviso = '0' where estudante_id = $1", [
    id,
  ]);
  await concluir.click();
  await expect(page).toHaveURL(/\/privacidade\/aceitar$/);
  expect(
    await contar("select count(*) as n from privado.conclusao where estudante_id = $1", [id]),
  ).toBe(0);
});

test("axe: Seus dados e o diálogo de apagar não têm violação", async ({ page }) => {
  await entrarSemAceite(page, "sem-aceite-axe");
  await page.goto("/privacidade/seus-dados");
  await expect(page.getByRole("heading", { level: 1, name: "Seus dados" })).toBeVisible();
  const pagina = await new AxeBuilder({ page }).analyze();
  expect(pagina.violations.map((v) => v.id)).toEqual([]);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await abrirDialogo(page);
  const aberto = await new AxeBuilder({ page }).analyze();
  expect(aberto.violations.map((v) => v.id)).toEqual([]);
});
