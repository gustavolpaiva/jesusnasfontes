import { expect, type Page, test } from "@playwright/test";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
} from "../../support/login-e2e";

// Visão geral das Trilhas e conclusão de um Estudo (TRIL-01, TRIL-04), sobre o conteúdo mínimo de
// teste: duas Trilhas de Estudos e a Leitura contínua. Só roda com a pasta de conteúdo mínimo
// (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo): com o conteúdo real os números mudam.
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

const conclusoesDe = (id: string) =>
  contar("select count(*) as n from privado.conclusao where estudante_id = $1", [id]);

test("as três Trilhas aparecem; abrir, concluir, voltar e ver o progresso mudar; desmarcar", async ({
  page,
}) => {
  const a = emailDeTeste("a");
  await convidarParaTeste(a);
  await entrarPorLink(page, a);
  const idA = await idDoUsuario(a);

  // As três Trilhas, com o filete de progresso e o texto "{n} de {total} concluídos".
  for (const [nome, total] of [
    ["Base histórica", 2],
    ["Pontos centrais", 3],
    ["Leitura contínua", 3],
  ] as const) {
    await expect(page.getByRole("button", { name: new RegExp(nome) })).toBeVisible();
    const filete = page.getByRole("progressbar", { name: `Progresso em ${nome}` });
    await expect(filete).toHaveAttribute("aria-valuenow", "0");
    await expect(filete).toHaveAttribute("aria-valuemax", String(total));
  }
  await expect(page.getByText("0 de 2 concluídos")).toBeVisible();
  await expect(page.getByText("0 de 3 concluídos · volta 1")).toBeVisible();

  // Abre a Base histórica e um Estudo dela.
  await page.getByRole("button", { name: /Base histórica/ }).click();
  await page.getByRole("link", { name: /Como sabemos o que sabemos/ }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Como sabemos o que sabemos" }),
  ).toBeVisible();

  // Primeiro Estudo da Trilha: "Anterior" não leva a lugar nenhum.
  await expect(page.getByRole("button", { name: "Anterior" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );

  // Concluir: a mensagem de estado e o primário vira "Próximo".
  await clicarQuandoHidratado(page, "Marcar como concluído");
  await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toHaveText(
    /Estudo concluído\. 1 de 2 em Base histórica\./,
  );
  await expect(page.getByRole("link", { name: "Próximo" })).toBeVisible();
  expect(await conclusoesDe(idA)).toBe(1);

  // De volta às Trilhas: "1 de 2 concluídos" na Base histórica, e o Estudo traz a marca de concluído.
  await page.goto("/trilhas");
  await expect(page.getByText("1 de 2 concluídos")).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Progresso em Base histórica" }),
  ).toHaveAttribute("aria-valuenow", "1");
  await expect(
    page.getByRole("link", { name: /Como sabemos o que sabemos.*concluído/ }),
  ).toBeVisible();

  // Desmarcar muda o progresso de volta.
  await page.getByRole("link", { name: /Como sabemos o que sabemos/ }).click();
  await clicarQuandoHidratado(page, "Desmarcar conclusão");
  await expect(page.getByRole("status").filter({ hasText: "Conclusão desmarcada." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Marcar como concluído" })).toBeVisible();
  expect(await conclusoesDe(idA)).toBe(0);
  await page.goto("/trilhas");
  await expect(page.getByText("0 de 2 concluídos")).toBeVisible();
});

test("o progresso é de cada conta: B não vê o de A", async ({ browser }) => {
  const a = emailDeTeste("a");
  const b = emailDeTeste("b");
  await convidarParaTeste(a);
  await convidarParaTeste(b);
  const contextoA = await browser.newContext();
  const pa = await contextoA.newPage();
  await entrarPorLink(pa, a);
  await pa.goto("/estudos/como-sabemos");
  await clicarQuandoHidratado(pa, "Marcar como concluído");
  await expect(pa.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible();
  await pa.goto("/trilhas");
  await expect(pa.getByText("1 de 2 concluídos")).toBeVisible();

  const contextoB = await browser.newContext();
  const pb = await contextoB.newPage();
  await entrarPorLink(pb, b);
  await expect(pb.getByText("0 de 2 concluídos")).toBeVisible();
  await expect(pb.getByText("1 de 2 concluídos")).toHaveCount(0);
  await contextoA.close();
  await contextoB.close();
});
