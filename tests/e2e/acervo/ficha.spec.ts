import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  ESPERADO_DA_COMPLETA,
  type FichasSemeadas,
  LIMITES_DA_COMPLETA,
  removerFichas,
  semearFichas,
  TRECHO_LONGO,
} from "../../support/ficha-e2e";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Ficha de uma obra da Pesquisa acadêmica (ACER-03, ACER-07, D-02, D-05, D-11; UI-SPEC tela 6). A obra é INVENTADA e a
// verificação nasce pelas funções reais do banco (`verificarFichaParaTeste`), nunca por evidência inserida direto.
// Semeada no `beforeAll` e removida no `afterAll` do arquivo; o sufixo do slug é o do projeto (celular e computador
// rodam o mesmo arquivo ao mesmo tempo no mesmo banco).

test.describe.configure({ mode: "default" });

let sufixo = "";
let semeadas: FichasSemeadas;

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = info.project.name;
  semeadas = await semearFichas(sufixo);
});

test.afterAll(async () => {
  if (sufixo) await removerFichas(sufixo);
});

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("acervo-ficha");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

function vigiarHidratacao(page: Page): string[] {
  const avisos: string[] = [];
  page.on("console", (m) => {
    if (/hydrat/i.test(m.text())) avisos.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/hydrat/i.test(e.message)) avisos.push(e.message);
  });
  return avisos;
}

const semRolagemHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test("a ficha verificada mostra a verificação sem nome, a edição, as seções em ordem e a página de cada item", async ({
  page,
}) => {
  const hidratacao = vigiarHidratacao(page);
  await entrar(page);
  const resposta = await page.goto(`/acervo/${semeadas.slugs.completa}`);
  expect(resposta?.status()).toBe(200);

  await expect(
    page.getByRole("heading", { level: 1, name: ESPERADO_DA_COMPLETA.titulo }),
  ).toBeVisible();
  const ficha = page.locator('[data-slot="ficha"]');
  await expect(ficha.getByText("Ficha", { exact: true }).first()).toBeVisible();
  await expect(ficha.getByText(ESPERADO_DA_COMPLETA.meta)).toBeVisible();
  await expect(page.locator('[data-slot="selo-nivel"]')).toHaveText("Pesquisa acadêmica");
  await expect(page.getByRole("link", { name: "Voltar ao Acervo" })).toHaveAttribute(
    "href",
    "/acervo",
  );

  // Verificação: data por extenso, sem nome, e a frase fixa.
  const verificacao = page.locator('[data-slot="verificacao"]');
  await expect(verificacao).toContainText(/Verificada em \d{1,2}º? de \p{L}+ de \d{4}/u);
  await expect(verificacao).toContainText(
    "Cada página citada foi conferida no livro por um Admin.",
  );

  // A edição consultada aparece sempre.
  const edicao = page.locator('[data-slot="edicao-consultada"]');
  await expect(edicao.locator("dt")).toHaveText("Edição consultada");
  await expect(edicao.locator("dd")).toHaveText(ESPERADO_DA_COMPLETA.edicao);

  await expect(
    page.getByText(
      "Esta ficha resume a obra. As frases entre aspas são citações curtas, cada uma com a sua página.",
    ),
  ).toBeVisible();

  // Seções na ordem fixa, cada uma com título de nível 2.
  await expect(page.getByRole("heading", { level: 2 })).toHaveText([
    "Tese",
    "Argumentos",
    "Trechos citados",
    "O que esta obra não pode dizer",
  ]);
  await expect(page.getByText(LIMITES_DA_COMPLETA)).toBeVisible();

  // Cada item mostra a página (p. 39–53 com travessão; p. xi–xii em numeral romano).
  const paginas = page.locator('[data-slot="pagina-do-item"] [aria-hidden="true"]');
  await expect(paginas).toHaveText(ESPERADO_DA_COMPLETA.paginas);
  // O leitor de tela lê "página 39 a 53", não o travessão.
  const faladas = page.locator('[data-slot="pagina-do-item"] .sr-only');
  await expect(faladas).toHaveText(["página 39 a 53", "página 7", "página xi a xii", "página 101"]);
  // O argumento é uma lista numerada.
  await expect(page.locator('ol > li [data-slot="item-de-ficha"]')).toHaveCount(2);

  // Trecho original: em <q lang>, com filete esquerdo de 2 px, e o texto cheio de até 300 caracteres.
  expect(TRECHO_LONGO.length).toBeLessThanOrEqual(300);
  const trechos = page.locator("q[lang='en']");
  await expect(trechos).toHaveCount(2);
  await expect(trechos.nth(1)).toHaveText(TRECHO_LONGO);
  const filete = await trechos.nth(1).evaluate((el) => {
    const c = getComputedStyle(el);
    return { largura: c.borderLeftWidth, recuo: c.paddingLeft };
  });
  expect(filete).toEqual({ largura: "2px", recuo: "16px" });
  await expect(page.getByText("Trechos entre aspas pertencem aos autores citados.")).toBeVisible();

  // A ficha não tem capitular (a capitular é só do texto do Estudo).
  expect(
    await page
      .locator('[data-slot="ficha"] .capitular, [data-slot="ficha"] [data-capitular]')
      .count(),
  ).toBe(0);

  expect(await semRolagemHorizontal(page)).toBe(true);
  expect(hidratacao).toEqual([]);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.passes.length).toBeGreaterThan(10);
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test("D-05: nem o e-mail nem o nome de quem verificou estão no HTML nem na resposta", async ({
  page,
}) => {
  await entrar(page);
  const corpos: string[] = [];
  page.on("response", async (r) => {
    if (r.url().includes(semeadas.slugs.completa)) corpos.push(await r.text().catch(() => ""));
  });
  const resposta = await page.goto(`/acervo/${semeadas.slugs.completa}`);
  const html = (await resposta?.text()) ?? "";
  expect(html).toContain("Obra de Teste Completa"); // controle positivo: o corpo lido é o da ficha
  const email = semeadas.emailDoAdmin;
  expect(email).toMatch(/@exemplo\.invalid$/);
  expect(html).not.toContain(email);
  expect(html).not.toContain(email.split("@")[0] as string);
  const dom = await page.content();
  expect(dom).not.toContain(email);
  expect(dom).not.toContain(email.split("@")[0] as string);
  for (const corpo of corpos) expect(corpo).not.toContain(email);
});

test("ficha em rascunho, inexistente e alterada depois de verificada dão o mesmo 'Página não encontrada'", async ({
  page,
}) => {
  await entrar(page);
  const paginas: Record<string, { status: number; titulo: string; corpo: string }> = {};
  for (const [nome, slug] of [
    ["rascunho", semeadas.slugs.rascunho],
    ["alterada", semeadas.slugs.alterada],
    ["inexistente", `ficha-que-nao-existe-${sufixo}`],
  ] as const) {
    const r = await page.goto(`/acervo/${slug}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeVisible();
    // Nenhuma palavra revela que existe um rascunho ou que a ficha foi alterada.
    await expect(page.getByText(/rascunho|alterad|verificad/i)).toHaveCount(0);
    paginas[nome] = {
      status: r?.status() ?? 0,
      titulo: await page.title(),
      corpo: ((await page.locator("main").textContent()) ?? "").replace(slug, "SLUG"),
    };
  }
  // (O status HTTP segue o do resto do Acervo: a página que faz streaming responde 200 antes do `notFound()`;
  // o que importa aqui é que os três casos não se distinguem em nada.)
  // Os três casos são indistinguíveis: mesmo status, mesmo título, mesmo texto da página.
  expect(paginas.alterada).toEqual(paginas.rascunho);
  expect(paginas.inexistente).toEqual(paginas.rascunho);
});

test("seção sem conteúdo não é renderizada e não deixa título solto", async ({ page }) => {
  await entrar(page);
  await page.goto(`/acervo/${semeadas.slugs.enxuta}`);
  await expect(page.getByRole("heading", { level: 1, name: "Obra de Teste Enxuta" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2 })).toHaveText(["Tese", "Argumentos"]);
  await expect(page.getByText("Trechos citados")).toHaveCount(0);
  await expect(page.getByText("O que esta obra não pode dizer")).toHaveCount(0);
  // Sem citação, a nota dos trechos entre aspas também não aparece; e não sobra um rodapé vazio.
  await expect(page.getByText("Trechos entre aspas pertencem")).toHaveCount(0);
  await expect(page.locator('[data-slot="rodape-da-ficha"]')).toHaveCount(0);
  await expect(page.locator("q")).toHaveCount(0);
  await expect(page.locator('[data-slot="pagina-do-item"] [aria-hidden="true"]')).toHaveText([
    "p. 5",
  ]);
});

test("sem a carta de neutralidade publicada, a ficha não oferece o link 'Por que estas obras?'", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(`/acervo/${semeadas.slugs.completa}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Obra de Teste Completa" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Por que estas obras/ })).toHaveCount(0);
});

test("a rota da Fonte de texto integral continua funcionando", async ({ page }) => {
  await entrar(page);
  const r = await page.goto("/acervo/josefo-antiguidades");
  expect(r?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { level: 1, name: "Antiguidades Judaicas" }),
  ).toBeVisible();
  await expect(page.locator('[data-slot="ficha"]')).toHaveCount(0);
});
