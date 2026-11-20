import { expect, type Page, test } from "@playwright/test";
import { VERSAO_AVISO } from "../../../src/modules/privacidade/aviso";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
  semearAdminParaTeste,
  sessoesDe,
} from "../../support/login-e2e";
import { gerarTotp } from "../../support/totp";

// Consentimento antes do primeiro uso (PRIV-01, PRIV-02). A pessoa convidada entra SEM o aceite
// registrado (`semConsentimento`): o resto da suíte entra já com ele.

const contarConsentimentos = (id: string) =>
  contar("select count(*) as n from privado.consentimento where estudante_id = $1", [id]);

async function entrarSemAceite(page: Page) {
  const endereco = emailDeTeste("consent");
  await convidarParaTeste(endereco, { semConsentimento: true });
  await entrarPorLink(page, endereco, "Antes de começar");
  return { endereco, id: await idDoUsuario(endereco) };
}

test("sem o aceite nenhuma tela do app abre e a navegação não aparece", async ({ page }) => {
  await entrarSemAceite(page);
  for (const rota of ["/trilhas", "/estudos/batismo-e-tentacao", "/caderno", "/conta"]) {
    await page.goto(rota);
    await expect(page, rota).toHaveURL(/\/privacidade\/aceitar$/);
    await expect(page.getByRole("heading", { level: 1, name: "Antes de começar" })).toBeVisible();
  }
  // Sem navegação (nem no cabeçalho, nem no rodapé): só a marca e o Menu, com Aparência e Sair.
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await expect(page.getByRole("link", { name: "Trilhas" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Caderno" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sair" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aparência" })).toBeVisible();
});

test("a caixa vem desmarcada e o botão sempre ativo; enviar sem marcar foca a caixa e nada é gravado", async ({
  page,
}) => {
  const { id } = await entrarSemAceite(page);
  const caixa = page.getByRole("checkbox");
  const botao = page.getByRole("button", { name: "Concordar e continuar" });
  await expect(caixa).not.toBeChecked();
  await expect(botao).toBeEnabled();
  await botao.click();
  const erro = page.locator('[data-slot="alert"]');
  await expect(erro).toContainText(
    "Marque a caixa para continuar. Sem o seu consentimento não podemos abrir o site para você.",
  );
  await expect(erro).toContainText("Erro.");
  await expect(caixa).toBeFocused();
  expect(await contarConsentimentos(id)).toBe(0);
  await expect(page).toHaveURL(/\/privacidade\/aceitar$/);
});

test("marcar e concordar grava versão e hash e leva às Trilhas", async ({ page }) => {
  const { id } = await entrarSemAceite(page);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Concordar e continuar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  expect(await contarConsentimentos(id)).toBe(1);
  expect(
    await contar(
      "select count(*) as n from privado.consentimento where estudante_id = $1 and versao_aviso = $2 and texto_hash ~ '^[0-9a-f]{64}$'",
      [id, VERSAO_AVISO],
    ),
  ).toBe(1);
  // Já aceitou: a tela de aceitar manda de volta às Trilhas.
  await page.goto("/privacidade/aceitar");
  await expect(page).toHaveURL(/\/trilhas$/);
});

test("o aviso diz o que o contrato exige, com o responsável do ambiente, em sete seções", async ({
  page,
}) => {
  await entrarSemAceite(page);
  await expect(page.locator("main h2")).toHaveCount(7);
  const texto = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  expect(texto).toContain(
    "O responsável é Responsável de teste. Contato: contato@convite.example.",
  );
  expect(texto).toContain(
    "quem administra o banco de dados e as contas da hospedagem teria acesso técnico",
  );
  expect(texto).toContain("O site impede que outros Estudantes e os Admins leiam suas Anotações");
  expect(texto).toContain(`Aviso versão ${VERSAO_AVISO}, de 19 de novembro de 2026.`);
  expect(texto).toContain("Li o aviso e consinto com o tratamento dos meus dados");
});

test("aceite de versão anterior: o aviso mudou e a pessoa consente de novo", async ({ page }) => {
  const { id } = await entrarSemAceite(page);
  await escrever(
    "insert into privado.consentimento (estudante_id, versao_aviso, texto_hash) values ($1, '0', 'antigo')",
    [id],
  );
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/privacidade\/aceitar$/);
  await expect(page.getByText("O aviso mudou. Leia de novo e confirme.")).toBeVisible();
  await expect(page.getByText("Leia como cuidamos do que você escreve aqui.")).toHaveCount(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Concordar e continuar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  // O aceite antigo continua como registro; o novo é da versão atual.
  expect(await contarConsentimentos(id)).toBe(2);
});

test("erro de gravação mostra a mensagem e não perde a marcação; depois funciona", async ({
  page,
}) => {
  const { id } = await entrarSemAceite(page);
  const nome = `jnf_teste_recusa_${id.replace(/-/g, "").slice(0, 12)}`;
  // Gatilho só para ESTA conta: as outras contas dos outros testes (em paralelo) seguem gravando.
  await escrever(
    `create function public.${nome}() returns trigger language plpgsql as $$ begin raise exception 'recusado pelo teste'; end $$`,
  );
  await escrever(
    `create trigger ${nome} before insert on privado.consentimento for each row when (new.estudante_id = '${id}') execute function public.${nome}()`,
  );
  try {
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Concordar e continuar" }).click();
    await expect(page.locator('[data-slot="alert"]')).toContainText(
      "Não conseguimos registrar o seu consentimento. Tente de novo.",
    );
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(await contarConsentimentos(id)).toBe(0);
  } finally {
    await escrever(`drop trigger if exists ${nome} on privado.consentimento`);
    await escrever(`drop function if exists public.${nome}()`);
  }
  await page.getByRole("button", { name: "Concordar e continuar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  expect(await contarConsentimentos(id)).toBe(1);
});

test("Não concordo, sair encerra a sessão sem gravar nada", async ({ page }) => {
  const { endereco, id } = await entrarSemAceite(page);
  expect(await sessoesDe(endereco)).toBe(1);
  await page.getByRole("button", { name: "Não concordo, sair" }).click();
  await expect(page).toHaveURL(/\/entrar\?saiu=1$/);
  expect(await contarConsentimentos(id)).toBe(0);
  expect(await sessoesDe(endereco)).toBe(0);
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
});

test("/privacidade abre sem sessão, só leitura, com o mesmo texto", async ({ page }) => {
  const resposta = await page.goto("/privacidade");
  expect(resposta?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Aviso de privacidade" })).toBeVisible();
  await expect(page.locator("main h2")).toHaveCount(7);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Concordar e continuar" })).toHaveCount(0);
  expect((await page.locator("main").innerText()).replace(/\s+/g, " ")).toContain(
    "teria acesso técnico",
  );
});

test("o Admin também só passa depois de consentir (área de administração e as demais)", async ({
  page,
}) => {
  const endereco = emailDeTeste("admin-consent");
  await semearAdminParaTeste(endereco, { semConsentimento: true });
  await entrarPorLink(page, endereco, "Ative o segundo fator");
  const chave = (await page.getByTestId("chave").innerText()).replace(/\s/g, "");
  await page.getByLabel("Código de 6 dígitos").fill(gerarTotp(chave));
  await page.getByRole("button", { name: "Ativar" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" })
    .waitFor();
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page).toHaveURL(/\/privacidade\/aceitar$/);
  for (const rota of ["/admin", "/trilhas"]) {
    await page.goto(rota);
    await expect(page, rota).toHaveURL(/\/privacidade\/aceitar$/);
  }
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Concordar e continuar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
});
