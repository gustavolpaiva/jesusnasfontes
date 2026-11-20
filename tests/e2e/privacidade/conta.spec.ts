import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { emailsPara, ultimoEmailPara } from "../../support/caixa-de-email";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
  lerTexto,
  pedirAcesso,
} from "../../support/login-e2e";

// Conta (PRIV-03, ANOT-05): dados, exportar todos os dados e apagar a conta com confirmação.

async function entrar(page: Page, prefixo = "conta"): Promise<{ email: string; id: string }> {
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return { email, id: await idDoUsuario(email) };
}

// Uma Anotação com marcador, direto no banco da execução (o editor é do plano 01-18).
async function semearAnotacao(id: string, marcador: string): Promise<void> {
  await escrever(
    "insert into privado.anotacao (estudante_id, estudo_id, corpo) values ($1, (select id from conteudo.estudo order by slug limit 1), $2)",
    [id, `corpo ${marcador}`],
  );
}

const usuarios = (id: string) =>
  contar('select count(*) as n from auth."user" where id = $1', [id]);
const anotacoes = (id: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]);

const botaoApagar = (page: Page) =>
  page.getByRole("button", { name: "Apagar minha conta" }).first();
const dialogo = (page: Page) => page.getByRole("alertdialog");

async function abrirDialogo(page: Page): Promise<void> {
  await page.goto("/conta");
  // Espera o React ligar o botão antes de clicar (o clique antes da hidratação não abre nada).
  await expect(async () => {
    await botaoApagar(page).click();
    await expect(dialogo(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test("a Conta mostra e-mail, aviso aceito e os quatro blocos; só o dono vê o arquivo", async ({
  page,
  request,
}) => {
  const { email } = await entrar(page);
  await page.goto("/conta");
  await expect(page.getByRole("heading", { level: 1, name: "Conta" })).toBeVisible();
  for (const h of ["Dados da conta", "Exportar meus dados", "Apagar minha conta", "Sair"]) {
    await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible();
  }
  await expect(page.getByTestId("conta-email")).toHaveText(email);
  await expect(
    page.getByText(/Aviso de privacidade aceito: versão 1, em \d{1,2} de \w+ de 20\d\d\./),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Ler o aviso" })).toHaveAttribute(
    "href",
    "/privacidade",
  );
  await expect(page.getByRole("button", { name: "Sair deste aparelho" })).toBeVisible();
  // Sem sessão o arquivo não sai: vai à entrada.
  const semSessao = await request.get("/conta/exportar", { maxRedirects: 0 });
  expect(semSessao.status()).toBeGreaterThanOrEqual(300);
  expect(semSessao.status()).toBeLessThan(400);
  expect(semSessao.headers().location).toContain("/entrar");
});

test("baixar os dados: o arquivo traz as chaves, as linhas da conta e nada de outra pessoa", async ({
  page,
}) => {
  const a = await entrar(page, "exporta-a");
  const outra = emailDeTeste("exporta-b");
  await convidarParaTeste(outra);
  const idB = await idDoUsuario(outra);
  const marcadorA = `MARCADOR-A-${a.id}`;
  const marcadorB = `MARCADOR-B-${idB}`;
  await semearAnotacao(a.id, marcadorA);
  await semearAnotacao(idB, marcadorB);

  await page.goto("/conta");
  const botao = page.getByRole("button", { name: "Baixar meus dados" });
  await expect(botao).toBeVisible();
  // O clique antes da hidratação não faz nada: tenta até o download começar.
  let download: import("@playwright/test").Download | undefined;
  await expect(async () => {
    const espera = page.waitForEvent("download", { timeout: 1500 });
    await botao.click();
    download = await espera;
  }).toPass();
  expect(download?.suggestedFilename()).toBe("jesus-nas-fontes-meus-dados.json");
  const bruto = readFileSync((await download?.path()) as string, "utf8");
  const dados = JSON.parse(bruto) as {
    geradoEm: string;
    versaoFormato: number;
    perfil: { email: string };
    convite: { estado: string };
    tabelas: Record<string, Record<string, unknown>[]>;
  };
  expect(Object.keys(dados)).toEqual(
    expect.arrayContaining(["geradoEm", "versaoFormato", "perfil", "convite", "tabelas"]),
  );
  expect(dados.versaoFormato).toBe(1);
  expect(dados.perfil.email).toBe(a.email);
  expect(dados.convite.estado).toBe("aceito");
  expect(Object.keys(dados.tabelas)).toEqual(
    expect.arrayContaining(["anotacao", "consentimento", "posicao", "conclusao", "volta_leitura"]),
  );
  expect(dados.tabelas.consentimento).toHaveLength(1);
  expect(bruto).toContain(marcadorA);
  expect(bruto).not.toContain(marcadorB);
  expect(bruto).not.toContain(outra);

  // O cabeçalho da resposta: anexo, sem cache.
  const resposta = await page.request.get("/conta/exportar");
  expect(resposta.status()).toBe(200);
  expect(resposta.headers()["cache-control"]).toBe("no-store");
  expect(resposta.headers()["content-disposition"]).toContain("attachment");
  expect(resposta.headers()["content-type"]).toContain("application/json");
});

test("exportar: preparando, erro do servidor e sem conexão", async ({ page, context }) => {
  await entrar(page, "exporta-erro");
  await page.goto("/conta");
  const botao = page.getByRole("button", { name: "Baixar meus dados" });
  await expect(botao).toBeVisible();

  // Erro do servidor, com o estado "Preparando o arquivo…" enquanto espera.
  await page.route("**/conta/exportar", async (rota) => {
    await new Promise((resolver) => setTimeout(resolver, 700));
    await rota.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await expect(async () => {
    await botao.click();
    await expect(page.getByRole("button", { name: "Preparando o arquivo…" })).toBeVisible({
      timeout: 1500,
    });
  }).toPass();
  await expect(page.getByText("Não foi possível gerar o arquivo. Tente de novo.")).toBeVisible();
  await page.unroute("**/conta/exportar");

  // Sem conexão: o erro de conexão, não o de arquivo.
  await context.setOffline(true);
  await page.getByRole("button", { name: "Baixar meus dados" }).click();
  await expect(page.getByText("Sem conexão. Tente de novo quando a conexão voltar.")).toBeVisible();
  await context.setOffline(false);
});

test("o diálogo de apagar abre com o foco em Cancelar; sem APAGAR digitado nada é apagado", async ({
  page,
}) => {
  const { id } = await entrar(page, "dialogo");
  await semearAnotacao(id, `MARCADOR-${id}`);
  await abrirDialogo(page);
  const d = dialogo(page);
  await expect(d.getByRole("heading", { name: "Apagar a conta?" })).toBeVisible();
  await expect(d.getByRole("button", { name: "Cancelar" })).toBeFocused();
  await expect(d.getByText(/podem guardar os dados por até 6 horas/)).toBeVisible();
  // Sessão recente: nenhuma etapa de código.
  await expect(d.getByLabel("Código de 6 dígitos")).toHaveCount(0);

  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(d.getByText("Digite APAGAR, em letras maiúsculas, para confirmar.")).toBeVisible();
  await d.getByLabel("Digite APAGAR").fill("apagar");
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(d.getByText("Digite APAGAR, em letras maiúsculas, para confirmar.")).toBeVisible();
  // O que foi digitado continua no campo.
  await expect(d.getByLabel("Digite APAGAR")).toHaveValue("apagar");
  expect(await usuarios(id)).toBe(1);
  expect(await anotacoes(id)).toBe(1);

  // Esc fecha e o foco volta ao botão que abriu.
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(botaoApagar(page)).toBeFocused();
  expect(await usuarios(id)).toBe(1);
});

test("apagar a conta (sessão recente): some tudo dela, a vizinha fica, e entrar de novo recebe a resposta neutra", async ({
  page,
}) => {
  const a = await entrar(page, "apaga-a");
  const outra = emailDeTeste("apaga-b");
  await convidarParaTeste(outra);
  const idB = await idDoUsuario(outra);
  await semearAnotacao(a.id, `MARCADOR-A-${a.id}`);
  await semearAnotacao(idB, `MARCADOR-B-${idB}`);

  await abrirDialogo(page);
  await dialogo(page).getByLabel("Digite APAGAR").fill("APAGAR");
  await dialogo(page).getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(page).toHaveURL(/\/entrar\?apagada=1$/);
  await expect(page.getByText("Sua conta foi apagada.")).toBeVisible();
  await expect(page.getByText("Aviso.")).toBeVisible();

  expect(await usuarios(a.id)).toBe(0);
  expect(await anotacoes(a.id)).toBe(0);
  for (const tabela of ["consentimento", "posicao", "conclusao", "volta_leitura"]) {
    expect(
      await contar(`select count(*) as n from privado.${tabela} where estudante_id = $1`, [a.id]),
    ).toBe(0);
  }
  expect(await contar("select count(*) as n from auth.session where user_id = $1", [a.id])).toBe(0);
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [a.email]),
  ).toBe(0);
  // Controle negativo: a conta vizinha ficou inteira.
  expect(await usuarios(idB)).toBe(1);
  expect(await anotacoes(idB)).toBe(1);
  expect(
    await contar("select count(*) as n from privado.consentimento where estudante_id = $1", [idB]),
  ).toBe(1);

  // A conta apagada pede acesso de novo: a mesma tela neutra de qualquer endereço, e nenhum e-mail sai.
  const acessos = () => emailsPara(a.email).filter((m) => /acesso/i.test(m.assunto)).length;
  const antes = acessos(); // o e-mail da entrada feita no começo do teste
  expect(antes).toBe(1);
  await pedirAcesso(page, a.email);
  await page.waitForTimeout(1500);
  expect(acessos()).toBe(antes);
  // E a sessão antiga não abre nada.
  await page.goto("/conta");
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
});

test("sessão antiga: o código de 6 dígitos vai ao e-mail e só o certo apaga", async ({ page }) => {
  const { email, id } = await entrar(page, "antiga");
  await semearAnotacao(id, `MARCADOR-${id}`);
  await escrever(
    "update auth.session set created_at = now() - interval '1 hour' where user_id = $1",
    [id],
  );
  await abrirDialogo(page);
  const d = dialogo(page);
  await expect(
    d.getByText(
      `Por segurança, confirme que é você. Enviamos um código de 6 dígitos para ${email}.`,
    ),
  ).toBeVisible();
  const mensagem = await ultimoEmailPara(email, { assunto: /apagar sua conta/i });
  const codigo = /: (\d{6})/.exec(mensagem.texto)?.[1] as string;
  expect(codigo).toMatch(/^\d{6}$/);

  await d.getByLabel("Digite APAGAR").fill("APAGAR");
  // Sem código e com código errado: nada é apagado, o texto digitado fica.
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(d.getByText(/Código inválido ou vencido/)).toBeVisible();
  const errado = codigo === "000000" ? "111111" : "000000";
  await d.getByLabel("Código de 6 dígitos").fill(errado);
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(d.getByText(/Código inválido ou vencido/)).toBeVisible();
  await expect(d.getByLabel("Digite APAGAR")).toHaveValue("APAGAR");
  expect(await usuarios(id)).toBe(1);
  expect(await anotacoes(id)).toBe(1);

  // O certo apaga.
  await d.getByLabel("Código de 6 dígitos").fill(codigo);
  await d.getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(page).toHaveURL(/\/entrar\?apagada=1$/);
  expect(await usuarios(id)).toBe(0);
  expect(await anotacoes(id)).toBe(0);
});

test("apagar em outra aba enquanto esta grava progresso: volta à entrada, sem erro cru e sem linha órfã", async ({
  page,
}) => {
  const { id } = await entrar(page, "corrida");
  const slug = await lerTexto("select slug as t from conteudo.estudo order by ordem limit 1");
  await page.goto(`/estudos/${slug}`);
  const concluir = page.getByRole("button", { name: "Marcar como concluído" });
  await expect(concluir).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Outra aba da mesma sessão apaga a conta.
  const outraAba = await page.context().newPage();
  await abrirDialogo(outraAba);
  await dialogo(outraAba).getByLabel("Digite APAGAR").fill("APAGAR");
  await dialogo(outraAba).getByRole("button", { name: "Apagar minha conta" }).click();
  await expect(outraAba).toHaveURL(/\/entrar\?apagada=1$/);
  expect(await usuarios(id)).toBe(0);

  // Esta aba ainda mostra o Estudo; ao concluir, a sessão já não existe.
  await concluir.click();
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
  await expect(page.getByText("Sua sessão terminou. Entre de novo.")).toBeVisible();
  await expect(page.getByText("Algo deu errado")).toHaveCount(0);
  expect(
    await contar("select count(*) as n from privado.conclusao where estudante_id = $1", [id]),
  ).toBe(0);
});

test("e-mail longo na Conta quebra sem estourar em 320 px", async ({ page }) => {
  const prefixo = "m".repeat(42);
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/conta");
  const alvo = page.getByTestId("conta-email");
  await expect(alvo).toHaveText(email);
  const caixa = await alvo.boundingBox();
  expect((caixa?.x ?? 0) + (caixa?.width ?? 0)).toBeLessThanOrEqual(320);
  const rolagem = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(rolagem).toBe(0);
});

test("axe: a Conta e o diálogo de apagar não têm violação", async ({ page }) => {
  await entrar(page, "axe");
  await page.goto("/conta");
  await expect(page.getByRole("heading", { level: 1, name: "Conta" })).toBeVisible();
  const pagina = await new AxeBuilder({ page }).analyze();
  expect(pagina.violations.map((v) => v.id)).toEqual([]);
  // O diálogo abre com um esmaecer de 200 ms e o axe mede o contraste no meio dele (falso positivo em
  // todos os textos do diálogo): com movimento reduzido ele já abre inteiro.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await abrirDialogo(page);
  const aberto = await new AxeBuilder({ page }).analyze();
  expect(
    aberto.violations.map((v) => ({
      id: v.id,
      nos: v.nodes.map((n) => [n.html.slice(0, 80), JSON.stringify(n.any[0]?.data)]),
    })),
  ).toEqual([]);
});
