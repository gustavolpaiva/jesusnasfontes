import { expect, type Page, test } from "@playwright/test";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
} from "../../support/login-e2e";

// Leitura contínua (TRIL-01, TRIL-06): a grade de capítulos, o fim da volta e a nova volta, sobre o
// conteúdo mínimo de teste (três capítulos: Mateus 5, Mateus 6 e Marcos 5). Só roda com a pasta de
// conteúdo mínimo (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

// O clique antes da hidratação não faz nada (o botão ainda não tem o tratador do React): espera o React
// ligar o botão antes de clicar, em vez de contar com a sorte do tempo.
async function clicarQuandoHidratado(page: Page, nome: string): Promise<void> {
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
  await botao.click();
}

const concluir = async (page: Page, slug: string) => {
  await page.goto(`/estudos/${slug}`);
  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible();
};

async function abrirLeitura(page: Page) {
  await page.goto("/trilhas");
  const gatilho = page.getByRole("button", { name: /Leitura contínua/ });
  if ((await gatilho.getAttribute("aria-expanded")) !== "true") await gatilho.click();
  await expect(gatilho).toHaveAttribute("aria-expanded", "true");
}

const casa = (page: Page, nome: string | RegExp) =>
  page.getByRole("link", { name: nome, exact: true });
const conclusoes = (id: string, volta: number) =>
  contar(
    "select count(*) as n from privado.conclusao c join conteudo.estudo e on e.id = c.estudo_id where c.estudante_id = $1 and c.volta = $2 and e.trilha_id = 'leitura-continua'",
    [id, String(volta)],
  );

test("a grade mostra os livros, os estados por forma e texto e as contagens 0, 1 e todas", async ({
  page,
}) => {
  const email = emailDeTeste("g");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  await page.goto("/trilhas");

  // Com zero concluídos: o texto do contrato, e o resumo sempre visível com a Trilha fechada.
  await expect(page.getByText("0 de 3 concluídos · volta 1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Mateus 5" })).toHaveCount(0); // fechada

  await abrirLeitura(page);
  // Grupos por livro, só os que têm capítulo.
  await expect(page.getByRole("heading", { level: 4, name: "Mateus" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4, name: "Marcos" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 4, name: "Lucas" })).toHaveCount(0);
  // Nomes acessíveis das casas e o estado de cada uma, por atributo e não por cor.
  for (const nome of ["Mateus 5", "Mateus 6", "Marcos 5"]) {
    await expect(page.getByRole("link", { name: nome, exact: true })).toHaveAttribute(
      "data-estado",
      "por-fazer",
    );
  }
  // O grid declarado no contrato.
  const colunas = await page
    .getByRole("link", { name: "Mateus 5", exact: true })
    .locator("xpath=ancestor::ul[1]")
    .evaluate((ul) => (ul as HTMLElement).style.gridTemplateColumns);
  expect(colunas).toBe("repeat(auto-fill, minmax(48px, 1fr))");

  // Um concluído (e é o Estudo atual, porque acabou de ser aberto): as duas marcas e o nome com as duas.
  await concluir(page, "mateus-5");
  await abrirLeitura(page);
  await expect(page.getByText("1 de 3 concluídos · volta 1")).toBeVisible();
  const mateus5 = casa(page, "Mateus 5, Estudo atual, concluído");
  await expect(mateus5).toHaveAttribute("data-estado", "atual-concluida");
  await expect(mateus5).toHaveAttribute("aria-current", "step");
  await expect(mateus5.locator("svg")).toHaveCount(1); // a marca de seleção
  // As outras continuam por fazer, sem marca.
  const mateus6 = page.getByRole("link", { name: "Mateus 6", exact: true });
  await expect(mateus6).toHaveAttribute("data-estado", "por-fazer");
  await expect(mateus6.locator("svg")).toHaveCount(0);
  await expect(mateus6).not.toHaveAttribute("aria-current", "step");
  // O bloco de volta terminada ainda não existe.
  await expect(page.getByText(/Você terminou a volta/)).toHaveCount(0);

  // Abrir o Mateus 6 passa o "atual" para ele; o Mateus 5 fica só concluído.
  await page.goto("/estudos/mateus-6");
  await abrirLeitura(page);
  await expect(casa(page, "Mateus 5, concluído")).toHaveAttribute("data-estado", "concluida");
  const atual = casa(page, "Mateus 6, Estudo atual");
  await expect(atual).toHaveAttribute("data-estado", "atual");
  // A borda da casa atual é de 2 px na cor da rubrica (a mesma do "Continuar de onde parei"), e a de uma
  // casa por fazer é de 1 px em outra cor: o estado não depende só de existir `aria-current`.
  const rubrica = await page
    .getByText("Continuar de onde parei")
    .evaluate((el) => getComputedStyle(el).color);
  await expect(atual).toHaveCSS("border-top-width", "2px");
  await expect(atual).toHaveCSS("border-top-color", rubrica);
  const porFazer = page.getByRole("link", { name: "Marcos 5", exact: true });
  await expect(porFazer).toHaveCSS("border-top-width", "1px");
  expect(await porFazer.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(rubrica);
});

test("concluir as três mostra a volta terminada; começar a volta 2 zera as casas e guarda a volta 1", async ({
  page,
}) => {
  const email = emailDeTeste("v");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  const id = await idDoUsuario(email);

  for (const slug of ["mateus-5", "mateus-6", "marcos-5"]) await concluir(page, slug);
  await page.goto("/trilhas");
  // Todas concluídas: o resumo e o bloco do contrato, com a frase e o botão da volta seguinte.
  await expect(page.getByText("3 de 3 concluídos · volta 1")).toBeVisible();
  await abrirLeitura(page);
  await expect(page.getByRole("heading", { name: "Você terminou a volta 1" })).toBeVisible();
  await expect(
    page.getByText(
      "Na próxima volta, cada capítulo traz outras três perguntas. O que você concluiu na volta 1 fica guardado.",
    ),
  ).toBeVisible();
  expect(await conclusoes(id, 1)).toBe(3);

  // Começar a volta 2, sem confirmação.
  await clicarQuandoHidratado(page, "Começar a volta 2");
  await expect(page.getByText("0 de 3 concluídos · volta 2")).toBeVisible();
  await expect(page.getByText(/Você terminou a volta/)).toHaveCount(0);
  for (const nome of ["Mateus 5", "Mateus 6", "Marcos 5"]) {
    // Nenhuma casa está concluída na volta 2 (a atual é só "atual").
    await expect(
      page.getByRole("link", { name: new RegExp(`^${nome}(, Estudo atual)?$`) }),
    ).toHaveAttribute("data-estado", /^(por-fazer|atual)$/);
  }
  // As conclusões da volta 1 ficam guardadas no banco; a volta 2 começa vazia.
  expect(await conclusoes(id, 1)).toBe(3);
  expect(await conclusoes(id, 2)).toBe(0);

  // Concluir na volta 2 conta na volta 2, e desmarcar só toca a volta 2.
  await concluir(page, "mateus-5");
  expect(await conclusoes(id, 2)).toBe(1);
  expect(await conclusoes(id, 1)).toBe(3);
  await page.goto("/trilhas");
  await expect(page.getByText("1 de 3 concluídos · volta 2")).toBeVisible();
  await page.goto("/estudos/mateus-5");
  await clicarQuandoHidratado(page, "Desmarcar conclusão");
  await expect(page.getByRole("button", { name: "Marcar como concluído" })).toBeVisible();
  expect(await conclusoes(id, 2)).toBe(0);
  expect(await conclusoes(id, 1)).toBe(3);
});

test("a volta é de cada conta: B segue na volta 1 e não vê o bloco de A", async ({ browser }) => {
  const a = emailDeTeste("a");
  const b = emailDeTeste("b");
  await convidarParaTeste(a);
  await convidarParaTeste(b);
  const ca = await browser.newContext();
  const pa = await ca.newPage();
  await entrarPorLink(pa, a);
  for (const slug of ["mateus-5", "mateus-6", "marcos-5"]) await concluir(pa, slug);
  await abrirLeitura(pa);
  await clicarQuandoHidratado(pa, "Começar a volta 2");
  await expect(pa.getByText("0 de 3 concluídos · volta 2")).toBeVisible();

  const cb = await browser.newContext();
  const pb = await cb.newPage();
  await entrarPorLink(pb, b);
  await expect(pb.getByText("0 de 3 concluídos · volta 1")).toBeVisible();
  await expect(pb.getByText("volta 2")).toHaveCount(0);
  await ca.close();
  await cb.close();
});

test("a nova volta troca o conjunto de três perguntas e mostra 'volta N' a partir da volta 2", async ({
  page,
}) => {
  const email = emailDeTeste("p");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);

  const perguntas = page.getByRole("region", { name: "Três perguntas para responder" });
  const textos = (conjunto: string) =>
    [1, 2, 3].map((n) => `Conjunto ${conjunto}, pergunta ${["um", "dois", "três"][n - 1]}?`);

  // Volta 1: o primeiro conjunto, sem rótulo de volta.
  await page.goto("/estudos/mateus-5");
  await expect(perguntas.getByRole("listitem")).toHaveText(textos("um"));
  await expect(page.locator("[data-volta]")).toHaveCount(0);

  // Terminar a volta 1 e começar a 2: o segundo conjunto, com o rótulo "volta 2", em qualquer capítulo.
  for (const slug of ["mateus-5", "mateus-6", "marcos-5"]) await concluir(page, slug);
  await abrirLeitura(page);
  await clicarQuandoHidratado(page, "Começar a volta 2");
  await expect(page.getByText("0 de 3 concluídos · volta 2")).toBeVisible();
  for (const slug of ["mateus-5", "marcos-5"]) {
    await page.goto(`/estudos/${slug}`);
    await expect(perguntas.getByRole("listitem")).toHaveText(textos("dois"));
    await expect(page.locator("[data-volta]")).toHaveText("volta 2");
  }

  // Volta 3: o terceiro conjunto.
  for (const slug of ["mateus-5", "mateus-6", "marcos-5"]) await concluir(page, slug);
  await abrirLeitura(page);
  await clicarQuandoHidratado(page, "Começar a volta 3");
  await expect(page.getByText("0 de 3 concluídos · volta 3")).toBeVisible();
  await page.goto("/estudos/mateus-6");
  await expect(perguntas.getByRole("listitem")).toHaveText(textos("três"));
  await expect(page.locator("[data-volta]")).toHaveText("volta 3");
});

test("Começar a volta 2 aberto como A não avança a volta de B depois de a conta trocar no navegador (revisão da fase, plano 01-20)", async ({
  browser,
}) => {
  const a = emailDeTeste("troca-va");
  const b = emailDeTeste("troca-vb");
  await convidarParaTeste(a);
  await convidarParaTeste(b);
  const contexto = await browser.newContext();
  const pa = await contexto.newPage();
  await entrarPorLink(pa, a);
  for (const slug of ["mateus-5", "mateus-6", "marcos-5"]) await concluir(pa, slug);
  await abrirLeitura(pa);
  await expect(pa.getByRole("button", { name: "Começar a volta 2" })).toBeVisible();

  // Outra aba do mesmo navegador sai e entra como B, que também terminou a volta 1.
  const pb = await contexto.newPage();
  await pb.goto("/trilhas");
  await pb.getByRole("button", { name: "Abrir menu" }).click();
  await pb.getByRole("button", { name: "Sair" }).click();
  await expect(pb.getByText("Você saiu.")).toBeVisible();
  await entrarPorLink(pb, b);
  for (const slug of ["mateus-5", "mateus-6", "marcos-5"]) await concluir(pb, slug);
  const idB = await idDoUsuario(b);

  // A volta é irreversível: o botão de A, ainda aberto, age sobre a sessão de agora (a de B).
  await clicarQuandoHidratado(pa, "Começar a volta 2");
  await expect(
    pa.getByText("Este navegador entrou com outra conta. Recarregue a página."),
  ).toBeVisible();
  expect(
    await contar(
      "select coalesce(max(volta_atual), 1) as n from privado.volta_leitura where estudante_id = $1",
      [idB],
    ),
  ).toBe(1);
  await contexto.close();
});
