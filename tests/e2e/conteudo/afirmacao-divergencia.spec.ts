import { expect, type Page, test } from "@playwright/test";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Afirmação com "Fonte em preparação" (TRIL-07, D-07) e Divergência entre tradições (TRIL-08), de
// ponta a ponta: o arquivo de content/ foi carregado no banco da execução e a página lê do banco.
// Roda sobre o conteúdo real (`content/`): o Estudo "Nicodemos: nascer de novo" tem uma Afirmação e
// uma Divergência; "O Verbo se fez carne" não tem nenhuma das duas.
test.skip(
  !!process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo real: rode sem E2E_CONTEUDO_DIR",
);

const NICODEMOS = "/estudos/nicodemos-nascer-de-novo";

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("c");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

// O clique antes da hidratação não faz nada: espera o React ligar o botão, em vez de contar com a sorte.
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

test("a Afirmação leva o chip 'Fonte em preparação' abaixo do bloco, sem sublinhado nem cor", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(NICODEMOS);
  const frase = page.locator('[data-afirmacao-id="pc17-a1"]');
  await expect(frase).toHaveText("Um líder religioso procura Jesus de noite");
  const chip = page.locator('[data-slot="chip-fonte"]');
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("Fonte em preparação");
  // O conteúdo chega por streaming dentro de um bloco oculto até a troca: só se mede o que já aparece.
  await expect(chip).toBeVisible();
  await expect(frase).toBeVisible();

  // Abaixo do bloco que contém a frase, e nunca sobre o texto: o chip começa depois do fim do último
  // trecho de texto do parágrafo. (Mede-se o trecho de texto que vem antes do chip, e não o `span` da
  // frase: a capitular, com `::first-letter`, deixa o `span` sem retângulos no Chromium.)
  const medidas = await chip.evaluate((el) => {
    const texto = el.previousSibling as Node;
    const trecho = document.createRange();
    trecho.selectNodeContents(texto);
    const caixa = trecho.getBoundingClientRect();
    return {
      fimDoTexto: caixa.bottom,
      alturaDoTexto: caixa.height,
      topoDoChip: el.getBoundingClientRect().top,
    };
  });
  expect(medidas.alturaDoTexto, "o trecho de texto tem altura").toBeGreaterThan(0);
  expect(medidas.topoDoChip + 1).toBeGreaterThanOrEqual(medidas.fimDoTexto);

  // O chip é informação, não botão: borda tracejada de 1 px, sem papel, fora da ordem de foco.
  await expect(chip).toHaveCSS("border-top-style", "dashed");
  await expect(chip).toHaveCSS("border-top-width", "1px");
  expect(await chip.getAttribute("role")).toBeNull();
  expect(await chip.getAttribute("tabindex")).toBeNull();
  expect(await chip.evaluate((el) => el.closest("a, button"))).toBeNull();

  // A frase não ganha sublinhado nem cor: é igual ao parágrafo em volta.
  const paragrafo = frase.locator("xpath=ancestor::p[1]");
  expect(await frase.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  expect(await frase.evaluate((el) => getComputedStyle(el).color)).toBe(
    await paragrafo.evaluate((el) => getComputedStyle(el).color),
  );
});

test("o resumo recolhido vem antes da primeira seção com Afirmação e abre ao clicar", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(NICODEMOS);
  const gatilho = page.getByRole("button", { name: "O que é “Fonte em preparação”?" });
  await expect(gatilho).toHaveAttribute("aria-expanded", "false");
  const texto = page.getByText("Esta frase afirma um fato histórico.");
  await expect(texto).toBeHidden();

  // Antes do título da primeira seção que contém a Afirmação.
  const titulo = page.getByRole("heading", { level: 2, name: "O que acontece" });
  const caixaGatilho = await gatilho.boundingBox();
  const caixaTitulo = await titulo.boundingBox();
  expect((caixaGatilho?.y ?? 0) + (caixaGatilho?.height ?? 0)).toBeLessThanOrEqual(
    caixaTitulo?.y ?? 0,
  );
  expect(caixaGatilho?.height ?? 0).toBeGreaterThanOrEqual(44);

  await clicarQuandoHidratado(page, "O que é “Fonte em preparação”?");
  await expect(gatilho).toHaveAttribute("aria-expanded", "true");
  await expect(texto).toBeVisible();
  await expect(texto).toContainText("leia com cautela");
});

test("a Divergência mostra as três tradições nomeadas, na mesma ordem e com o mesmo peso", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(NICODEMOS);
  const secao = page.getByRole("region", { name: "Divergência entre tradições" });
  await expect(secao).toBeVisible();
  await expect(secao).toContainText(
    "Cristãos de tradições diferentes leem este ponto de formas diferentes. Mostramos cada leitura, sem escolher uma.",
  );
  const nomes = secao.getByRole("heading", { level: 3 });
  await expect(nomes).toHaveText([
    "Tradição católica",
    "Tradição ortodoxa",
    "Tradição protestante",
  ]);

  const caixas: { x: number; y: number; width: number; height: number }[] = [];
  for (const bloco of await secao.locator("[data-tradicao]").all()) {
    const caixa = await bloco.boundingBox();
    if (!caixa) throw new Error("tradição sem caixa");
    caixas.push(caixa);
  }
  expect(caixas).toHaveLength(3);
  const [c0, c1, c2] = caixas as [
    (typeof caixas)[number],
    (typeof caixas)[number],
    (typeof caixas)[number],
  ];
  const largura = page.viewportSize()?.width ?? 0;
  if (largura >= 1024) {
    // Colunas lado a lado, iguais, na ordem fixa.
    expect(c0.x).toBeLessThan(c1.x);
    expect(c1.x).toBeLessThan(c2.x);
    expect(Math.abs(c0.width - c1.width)).toBeLessThan(1.5);
    expect(Math.abs(c1.width - c2.width)).toBeLessThan(1.5);
    expect(Math.abs(c0.y - c2.y)).toBeLessThan(1.5);
  } else {
    // Empilhadas na coluna, na mesma ordem, com a mesma largura.
    expect(c0.y).toBeLessThan(c1.y);
    expect(c1.y).toBeLessThan(c2.y);
    expect(Math.abs(c0.x - c2.x)).toBeLessThan(1.5);
    expect(Math.abs(c0.width - c2.width)).toBeLessThan(1.5);
  }
  // Nenhuma tradição leva acento de cor: o nome de cada uma tem a mesma cor.
  const cores = await nomes.evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(new Set(cores).size).toBe(1);
});

test("Estudo sem Afirmação nem Divergência não deixa título de seção vazio nem aviso solto", async ({
  page,
}) => {
  await entrar(page);
  // "O Verbo se fez carne" é ensino sem acontecimento a marcar: sem Afirmação e sem Divergência.
  await page.goto("/estudos/o-verbo-se-fez-carne");
  await expect(page.getByRole("heading", { level: 1, name: "O Verbo se fez carne" })).toBeVisible();
  await expect(page.getByText("Divergência entre tradições")).toHaveCount(0);
  await expect(page.getByText("Fonte em preparação")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /O que é “Fonte em preparação”/ })).toHaveCount(0);
  // Todo título de seção do corpo tem texto.
  const titulos = await page
    .locator("[data-corpo-estudo] h2, [data-corpo-estudo] h3")
    .allTextContents();
  expect(titulos.length).toBeGreaterThan(0);
  for (const t of titulos) expect(t.trim()).not.toBe("");
});
