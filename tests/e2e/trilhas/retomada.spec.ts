import { expect, test } from "@playwright/test";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Retomada entre aparelhos (TRIL-05): a mesma conta em dois contextos de navegador (sem cookie em
// comum) vê o último Estudo aberto em qualquer um deles. Roda sobre o conteúdo mínimo de teste.
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

test("o segundo aparelho mostra 'Continuar de onde parei' com o Estudo aberto no primeiro", async ({
  browser,
}) => {
  const email = emailDeTeste("r");
  await convidarParaTeste(email);

  const aparelho1 = await browser.newContext();
  const p1 = await aparelho1.newPage();
  await entrarPorLink(p1, email);
  // Sem nada aberto ainda: "Começar".
  await expect(p1.getByText("Começar", { exact: true })).toBeVisible();
  await p1.goto("/estudos/o-nascimento");
  await expect(p1.getByRole("heading", { level: 1, name: "O nascimento" })).toBeVisible();

  // Outro aparelho: outro contexto, outra entrada, a MESMA conta.
  const aparelho2 = await browser.newContext();
  const p2 = await aparelho2.newPage();
  await entrarPorLink(p2, email);
  const bloco2 = p2.getByRole("region", { name: "Continuar de onde parei" });
  await expect(bloco2.getByText("O nascimento")).toBeVisible();
  await expect(bloco2.getByRole("link", { name: "Continuar", exact: true })).toHaveAttribute(
    "href",
    "/estudos/o-nascimento",
  );

  // No segundo aparelho abre-se outro Estudo; o primeiro, ao recarregar, mostra o mais recente.
  await p2.goto("/estudos/o-endemoninhado");
  await expect(
    p2.getByRole("heading", { level: 1, name: "O endemoninhado de Gerasa" }),
  ).toBeVisible();
  await p1.goto("/trilhas");
  const bloco1 = p1.getByRole("region", { name: "Continuar de onde parei" });
  await expect(bloco1.getByText("O endemoninhado de Gerasa")).toBeVisible();
  await expect(bloco1.getByRole("link", { name: "Continuar", exact: true })).toHaveAttribute(
    "href",
    "/estudos/o-endemoninhado",
  );
  await aparelho1.close();
  await aparelho2.close();
});
