import { expect, type Page, test } from "@playwright/test";
import { ultimoEmailPara } from "../../support/caixa-de-email";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
  isolarIp,
  lerTexto,
  pedirAcesso,
} from "../../support/login-e2e";

// O esqueleto ambulante, localmente: convite, entrada (link para A, código para B), Trilhas com
// "Começar", o Estudo com a Passagem lida do banco, a posição gravada só para quem abriu e o
// "Continuar de onde parei". Cada afirmação negativa tem o controle positivo ao lado.

const RETOMAR = "Continuar de onde parei";

async function sair(page: Page) {
  await page.getByRole("button", { name: "Abrir menu" }).click();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page.getByText("Você saiu.")).toBeVisible();
}

const posicoesDe = (id: string) =>
  contar("select count(*) as n from privado.posicao where estudante_id = $1", [id]);

test("convite até o Estudo: A abre e é lembrada; B, que não abriu, vê Começar", async ({
  browser,
}) => {
  const a = emailDeTeste("a");
  const b = emailDeTeste("b");
  await convidarParaTeste(a);
  await convidarParaTeste(b);
  const idA = await idDoUsuario(a);
  const idB = await idDoUsuario(b);
  expect(await posicoesDe(idA)).toBe(0);

  // A entra pelo link.
  const contextoA = await browser.newContext();
  const pa = await contextoA.newPage();
  await entrarPorLink(pa, a);
  await expect(pa.getByText("Começar", { exact: true })).toBeVisible();
  await expect(pa.getByText(RETOMAR)).toHaveCount(0);

  // Abre o primeiro Estudo.
  await pa.getByRole("link", { name: "Começar pelo primeiro Estudo" }).click();
  // Com o conteúdo completo, o primeiro Estudo é o primeiro da Base histórica (Lucas 1:1-4).
  await expect(pa).toHaveURL(/\/estudos\/o-que-a-historia-consegue-afirmar$/);
  await expect(
    pa.getByRole("heading", { level: 1, name: "O que a história consegue afirmar" }),
  ).toBeVisible();
  const leitura = pa.getByRole("region", { name: "Leitura" });
  await expect(leitura.getByRole("heading", { name: "Lucas 1:1-4" })).toBeVisible();
  await expect(leitura.locator("sup")).toHaveCount(4);
  // Um capítulo só na Passagem: sem subtítulo de capítulo.
  await expect(leitura.getByRole("heading", { level: 4 })).toHaveCount(0);
  await expect(leitura.getByRole("link", { name: "Créditos" })).toBeVisible();

  // O texto na tela é, letra por letra, o que está no banco (n4), nos versículos de pontas e do meio.
  for (const chave of ["42001001", "42001002", "42001004"]) {
    const noBanco = await lerTexto(
      "select conteudo as t from acervo.texto_versiculo where texto_id = 'blivre-n4' and versiculo_id = $1::int",
      [chave],
    );
    expect(noBanco.length).toBeGreaterThan(20);
    const naTela = await pa.locator(`[data-versiculo="${chave}"] [data-texto]`).textContent();
    expect(naTela).toBe(noBanco);
  }

  // O corpo do Estudo vem do conteúdo: seção em Rótulo (h2) abaixo do h1.
  await expect(pa.getByRole("heading", { level: 2, name: "O ponto" })).toBeVisible();

  // A posição foi gravada para A e só para A (controle: B continua com zero).
  expect(await posicoesDe(idA)).toBe(1);
  expect(await posicoesDe(idB)).toBe(0);

  // Página de uma pessoa só: sem cache.
  const resposta = await pa.goto("/trilhas");
  expect(resposta?.headers()["cache-control"]).toContain("no-store");

  // De volta às Trilhas: "Continuar de onde parei" com o Estudo.
  await expect(pa.getByText(RETOMAR)).toBeVisible();
  // O título também está na lista da Trilha aberta (plano 01-13): o bloco de retomar é a região própria.
  const bloco = pa.getByRole("region", { name: RETOMAR });
  await expect(bloco.getByText("O que a história consegue afirmar")).toBeVisible();
  await expect(pa.getByRole("link", { name: "Continuar", exact: true })).toHaveAttribute(
    "href",
    "/estudos/o-que-a-historia-consegue-afirmar",
  );
  await sair(pa);
  await contextoA.close();

  // B entra pelo código de 6 dígitos, no contexto sem cookie nenhum.
  const contextoB = await browser.newContext();
  const pb = await contextoB.newPage();
  await isolarIp(pb);
  await pedirAcesso(pb, b);
  const { codigo } = await ultimoEmailPara(b);
  expect(codigo).toMatch(/^\d{6}$/);
  await pb.getByLabel("Código de 6 dígitos").fill(codigo as string);
  await pb.getByRole("button", { name: "Entrar com o código" }).click();
  await expect(pb.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  // B não vê o Estudo de A: "Começar", e nenhum rastro do título nem do bloco de retomar.
  await expect(pb.getByText("Começar", { exact: true })).toBeVisible();
  await expect(pb.getByText(RETOMAR)).toHaveCount(0);
  await expect(pb.getByText("O que a história consegue afirmar")).toHaveCount(0);
  expect(await posicoesDe(idB)).toBe(0);

  // Controle positivo: B abre o Estudo e passa a ver o bloco, com a posição dele (uma por pessoa).
  await pb.getByRole("link", { name: "Começar pelo primeiro Estudo" }).click();
  await expect(
    pb.getByRole("heading", { level: 1, name: "O que a história consegue afirmar" }),
  ).toBeVisible();
  await pb.goto("/trilhas");
  await expect(pb.getByText(RETOMAR)).toBeVisible();
  expect(await posicoesDe(idB)).toBe(1);
  expect(await posicoesDe(idA)).toBe(1);
  await contextoB.close();
});

test("um Estudo que não existe é a página comum de não encontrado, sem gravar posição", async ({
  page,
}) => {
  const a = emailDeTeste("a");
  await convidarParaTeste(a);
  await entrarPorLink(page, a);
  await page.goto("/estudos/nao-existe");
  await expect(
    page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
  ).toBeVisible();
  expect(await posicoesDe(await idDoUsuario(a))).toBe(0);
});
