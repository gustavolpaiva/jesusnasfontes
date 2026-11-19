import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
} from "../../support/login-e2e";

// A tela do Estudo (TRIL-02, TRIL-04): eyebrow, texto bíblico e seus estados, navegação, desmarcar e
// erros. Roda sobre o conteúdo mínimo de teste (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

async function entrar(page: Page, prefixo = "a"): Promise<string> {
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return email;
}

const eyebrow = (page: Page) => page.locator("article header p").first();
// O clique antes da hidratação não faz nada (o botão ainda não tem o tratador do React): espera o React
// ligar o botão antes de clicar, em vez de contar com a sorte do tempo.
async function aguardarHidratado(page: Page, nome: string): Promise<void> {
  const botao = page.getByRole("button", { name: nome });
  await botao.waitFor();
  await botao.evaluate(
    (el) =>
      new Promise<void>((pronto) => {
        const ligado = () => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
        const olhar = () => (ligado() ? pronto() : setTimeout(olhar, 25));
        olhar();
      }),
  );
}

async function clicarQuandoHidratado(page: Page, nome: string): Promise<void> {
  await aguardarHidratado(page, nome);
  await page.getByRole("button", { name: nome }).click();
}

const conclusoesDe = (id: string) =>
  contar("select count(*) as n from privado.conclusao where estudante_id = $1", [id]);

test("o eyebrow nas três formas do contrato, com '· concluído' depois de concluir", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/estudos/os-manuscritos");
  await expect(eyebrow(page)).toHaveText("Base histórica · estudo 2 de 2");
  await page.goto("/estudos/o-endemoninhado");
  await expect(eyebrow(page)).toHaveText("Pontos centrais · estudo 3 de 3 · Sinais e encontros");
  await page.goto("/estudos/mateus-5");
  await expect(eyebrow(page)).toHaveText("Leitura contínua · Mateus 5 · capítulo 5 de 28");
  await expect(page.getByText("um capítulo, de 4 a 8 minutos")).toBeVisible();
  await page.goto("/estudos/marcos-5");
  await expect(eyebrow(page)).toHaveText("Leitura contínua · Marcos 5 · capítulo 5 de 16");

  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible();
  // A mesma resposta da ação já atualiza a linha de cima.
  await expect(eyebrow(page)).toHaveText(
    "Leitura contínua · Marcos 5 · capítulo 5 de 16 · concluído",
  );
});

test("Passagem com subtítulo por capítulo, número em sup e crédito; recolher e mostrar", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/estudos/batismo-e-tentacao");
  const leitura = page.getByRole("region", { name: "Leitura" });
  await expect(
    leitura.getByRole("heading", { level: 3, name: "Mateus 3:13 a 4:11" }),
  ).toBeVisible();
  await expect(leitura.getByRole("heading", { level: 4 })).toHaveText(["Mateus 3", "Mateus 4"]);
  await expect(leitura.locator("sup")).toHaveCount(16);
  await expect(leitura.getByText(/Bíblia Livre \(texto crítico, Nestle 1904\)/)).toBeVisible();
  await expect(leitura.getByText("Os sinais « » marcam", { exact: false })).toBeVisible();
  await expect(leitura.getByRole("link", { name: "Créditos" })).toBeVisible();
  await expect(leitura.getByText(/Nesta edição, o versículo/)).toHaveCount(0);

  // Recolher: o texto some, o botão passa a "Mostrar o texto" e `aria-expanded` acompanha.
  const botao = leitura.getByRole("button", { name: "Recolher o texto" });
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await botao.click();
  await expect(leitura.locator("sup")).toHaveCount(0);
  const mostrar = leitura.getByRole("button", { name: "Mostrar o texto" });
  await expect(mostrar).toHaveAttribute("aria-expanded", "false");
  await mostrar.click();
  await expect(leitura.locator("sup")).toHaveCount(16);

  // O salto leva ao corpo do Estudo.
  await expect(leitura.getByRole("link", { name: "Ir para o Estudo" })).toHaveAttribute(
    "href",
    "#estudo",
  );
});

test("versículo mesclado mostra a nota e não mostra o número; Estudo sem Passagem mostra a meta", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/estudos/o-endemoninhado");
  const leitura = page.getByRole("region", { name: "Leitura" });
  await expect(leitura.getByText("Nesta edição, o versículo 19 está junto do 18.")).toBeVisible();
  await expect(leitura.locator('[data-versiculo="41005019"]')).toHaveCount(0);
  await expect(leitura.locator('[data-versiculo="41005018"]')).toHaveCount(1);

  await page.goto("/estudos/como-sabemos");
  await expect(page.getByRole("region", { name: "Leitura" })).toHaveCount(0);
  await expect(page.getByText("sem leitura bíblica neste Estudo")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "O ponto" })).toBeVisible();
});

test("navegação: Anterior desabilitado no primeiro, Voltar às Trilhas no último; nada avança sozinho", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/estudos/como-sabemos");
  const anterior = page.getByRole("button", { name: "Anterior" });
  await expect(anterior).toHaveAttribute("aria-disabled", "true");
  await anterior.click({ force: true });
  await expect(page).toHaveURL(/\/estudos\/como-sabemos$/);

  await page.goto("/estudos/os-manuscritos");
  await expect(page.getByRole("link", { name: "Anterior" })).toHaveAttribute(
    "href",
    "/estudos/como-sabemos",
  );
  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible();
  // Último Estudo da Trilha: "Voltar às Trilhas" no lugar de "Próximo", e a página não saiu do lugar.
  await expect(page.getByRole("link", { name: "Voltar às Trilhas" })).toHaveAttribute(
    "href",
    "/trilhas",
  );
  await expect(page.getByRole("link", { name: "Próximo" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/estudos\/os-manuscritos$/);
});

test("concluir, ver a mensagem do contrato, desmarcar", async ({ page }) => {
  const email = await entrar(page);
  const id = await idDoUsuario(email);
  await page.goto("/estudos/o-nascimento");
  await expect(page.getByRole("link", { name: "Próximo" })).toHaveCount(0);
  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toContainText(
    "Estudo concluído. 1 de 3 em Pontos centrais.",
  );
  await expect(page.getByRole("link", { name: "Próximo" })).toHaveAttribute(
    "href",
    "/estudos/batismo-e-tentacao",
  );
  expect(await conclusoesDe(id)).toBe(1);
  await clicarQuandoHidratado(page, "Desmarcar conclusão");
  await expect(page.getByRole("button", { name: "Marcar como concluído" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Próximo" })).toHaveCount(0);
  expect(await conclusoesDe(id)).toBe(0);
});

test("sem conexão: concluir mostra o erro de conexão e não guarda fila", async ({
  page,
  context,
}) => {
  const email = await entrar(page);
  const id = await idDoUsuario(email);
  await page.goto("/estudos/o-nascimento");
  await aguardarHidratado(page, "Marcar como concluído");
  await context.setOffline(true);
  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("alert").filter({ hasText: "Sem conexão." })).toContainText(
    "Sem conexão. Tente de novo quando a conexão voltar.",
  );
  await expect(page.getByRole("button", { name: "Marcar como concluído" })).toBeVisible();
  expect(await conclusoesDe(id)).toBe(0);
  // Voltou a conexão: nada foi guardado para reenviar; só uma nova tentativa grava.
  await context.setOffline(false);
  await page.waitForTimeout(1500);
  expect(await conclusoesDe(id)).toBe(0);
  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible();
  expect(await conclusoesDe(id)).toBe(1);
});

test("slug inexistente é a página não encontrada", async ({ page }) => {
  await entrar(page);
  await page.goto("/estudos/nao-existe-mesmo");
  await expect(
    page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
  ).toBeVisible();
});

test("axe sem violações no Estudo com Passagem e nas Trilhas", async ({ page }) => {
  await entrar(page);
  await page.goto("/estudos/batismo-e-tentacao");
  await expect(page.getByRole("region", { name: "Leitura" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.goto("/trilhas");
  // A Trilha do último Estudo aberto já vem aberta; abre as outras duas para o axe ver as listas.
  for (const nome of [/Base histórica/, /Pontos centrais/, /Leitura contínua/]) {
    const gatilho = page.getByRole("button", { name: nome });
    if ((await gatilho.getAttribute("aria-expanded")) !== "true") await gatilho.click();
    await expect(gatilho).toHaveAttribute("aria-expanded", "true");
  }
  await expect(page.getByRole("link", { name: /O nascimento/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("@varredura passo 5: sem rolagem horizontal no Estudo", async ({ page, baseURL }) => {
  await page
    .context()
    .addCookies([{ name: "escala-texto", value: "5", url: baseURL ?? "http://localhost" }]);
  await entrar(page);
  for (const caminho of ["/estudos/os-manuscritos", "/estudos/batismo-e-tentacao", "/trilhas"]) {
    await page.goto(caminho);
    await page.getByRole("heading", { level: 1 }).waitFor();
    const sobra = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(sobra, `${caminho}: rolagem horizontal`).toBeLessThanOrEqual(0);
  }
});
