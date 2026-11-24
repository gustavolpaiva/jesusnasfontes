import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { removerExtras, type SlugsExtras, semearExtras } from "../../support/acervo-extras";
import { convidarParaTeste, emailDeTeste, entrarPorLink, escrever } from "../../support/login-e2e";

// Página da Fonte (ACER-02, ACER-04, D-07): proveniência sempre visível, aviso de tradução, limites, sumário
// e o texto direto na obra de uma só seção. Os estados raros (traduzida por nós, uma só seção, sem limites)
// vêm das Fontes de teste de `tests/fixtures/acervo/fontes-extras`, semeadas sob demanda e removidas no fim.
// Os dois projetos (celular e computador) rodam o arquivo ao mesmo tempo no mesmo banco: o sufixo do slug é
// o do projeto.

// As Fontes de teste são semeadas e removidas por arquivo: com `fullyParallel` o Playwright espalharia os
// testes por vários processos, e o `afterAll` de um tiraria a Fonte de quem ainda a usa. Um arquivo, um processo.
test.describe.configure({ mode: "default" });

let sufixo = "";
let extras: SlugsExtras;
let slugFicha = "";
let slugRascunho = "";
let slugMarcado = "";

const MARCADO = `Título com <b id="intruso">marcação</b> e <img src="x" onerror="window.__xss=1">`;

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = info.project.name;
  extras = await semearExtras(sufixo);
  slugFicha = `fonte-ficha-e2e-${sufixo}`;
  slugRascunho = `fonte-rascunho-e2e-${sufixo}`;
  slugMarcado = `fonte-marcada-e2e-${sufixo}`;
  // Uma Fonte de ficha (tem tela própria, mais adiante) e uma Fonte não publicada: nenhuma tem página aqui.
  await escrever(
    `insert into acervo.fonte (slug, nivel, titulo, tipo_texto, idioma, publicada)
     values ($1, 'academica', 'Ficha de teste', 'ficha', 'pt', true) on conflict (slug) do nothing`,
    [slugFicha],
  );
  await escrever(
    `insert into acervo.fonte (slug, nivel, titulo, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
     values ($1, 'primaria', 'Rascunho de teste', 'integral', 'en', 'dp-dedicado', 'Origem de teste',
             'https://exemplo.org/', false) on conflict (slug) do nothing`,
    [slugRascunho],
  );
  // Campos de Fonte com marcação: tudo é texto, nada vira elemento (T-02-21).
  await escrever(
    `insert into acervo.fonte (slug, nivel, titulo, autor, tipo_texto, idioma, licenca, origem_nome, origem_url, limites_pt, publicada)
     values ($1, 'primaria', $2, $2, 'integral', 'en', 'dp-dedicado', $2, 'https://exemplo.org/', $2, true)
     on conflict (slug) do nothing`,
    [slugMarcado, MARCADO],
  );
  await escrever(
    `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt)
     select $1 || '/1', id, '1', 1, $2, $2 from acervo.fonte where slug = $1
     on conflict (id) do nothing`,
    [slugMarcado, MARCADO],
  );
  await escrever(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
     values ($1 || '/1.1', $1 || '/1', 1, $2, '1.1', 'en') on conflict (id) do nothing`,
    [slugMarcado, MARCADO],
  );
});

test.afterAll(async () => {
  await removerExtras(sufixo);
  for (const slug of [slugFicha, slugRascunho, slugMarcado]) {
    await escrever(
      "delete from acervo.fonte_paragrafo where secao_id in (select id from acervo.fonte_secao where fonte_id in (select id from acervo.fonte where slug = $1))",
      [slug],
    );
    await escrever(
      "delete from acervo.fonte_secao where fonte_id in (select id from acervo.fonte where slug = $1)",
      [slug],
    );
    await escrever("delete from acervo.fonte where slug = $1", [slug]);
  }
});

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("acervo-fonte");
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

const AVISO = /Esta tradução foi feita por nós e ainda não foi revisada por especialista/;

test("a Fonte de várias seções mostra proveniência, limites e sumário, e sem aviso de tradução", async ({
  page,
}) => {
  const hidratacao = vigiarHidratacao(page);
  await entrar(page);
  await page.goto("/acervo/josefo-antiguidades");

  await expect(
    page.getByRole("heading", { level: 1, name: "Antiguidades Judaicas" }),
  ).toBeVisible();
  await expect(page.getByText("Flávio Josefo · cerca de 93 d.C.")).toBeVisible();
  await expect(page.locator('[data-slot="selo-nivel"]')).toHaveText("Fonte primária");
  await expect(page.getByRole("link", { name: "Voltar ao Acervo" })).toHaveAttribute(
    "href",
    "/acervo",
  );

  // Os cinco termos da proveniência, com o valor de cada um.
  const bloco = page.locator('[data-slot="bloco-proveniencia"]');
  await expect(bloco.locator("dt")).toHaveText([
    "Nível de fonte",
    "Origem do texto",
    "Licença",
    "Tradução",
    "Idioma do texto",
  ]);
  await expect(bloco).toContainText("Fonte primária");
  await expect(bloco).toContainText("Perseus Digital Library");
  await expect(bloco).toContainText(
    "Edição digital: CC BY-SA. Tradução de William Whiston, 1737: domínio público.",
  );
  await expect(bloco).toContainText("William Whiston, 1737");
  await expect(bloco).toContainText("The Works of Flavius Josephus, Alden and Beardsley, 1856");
  await expect(bloco).toContainText("Inglês");

  // O endereço de origem é link para fora, com a palavra só para leitor de tela; o texto da licença idem.
  const origem = bloco.getByRole("link", { name: /perseus\.tufts\.edu/ });
  await expect(origem).toHaveAttribute("href", "https://www.perseus.tufts.edu/");
  await expect(origem).toHaveAttribute("rel", /noopener/);
  await expect(origem).toContainText("(abre fora do site)");
  await expect(origem.locator(".sr-only")).toHaveText(" (abre fora do site)");
  await expect(bloco.getByRole("link", { name: /Texto da licença/ })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by-sa/4.0/",
  );

  // Fonte comum: nenhum aviso de tradução.
  await expect(page.getByText(AVISO)).toHaveCount(0);

  await expect(
    page.getByText("Este texto está em inglês, na tradução de William Whiston."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "O que esta Fonte não pode dizer" }),
  ).toBeVisible();

  // Sumário: um link por seção, com o número de parágrafos.
  await expect(page.getByRole("heading", { name: "Seções (2)" })).toBeVisible();
  const linhas = page.locator('[data-slot="linha-secao"]');
  await expect(linhas).toHaveCount(2);
  await expect(linhas.first()).toContainText("Livro 18");
  await expect(linhas.first()).toContainText("1 parágrafo");
  await expect(page.getByRole("heading", { name: "Texto", exact: true })).toHaveCount(0);
  for (const caixa of await linhas.all()) {
    expect((await caixa.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(64);
  }

  expect(hidratacao).toEqual([]);
  expect(await semRolagemHorizontal(page)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // O link do sumário leva à seção.
  await linhas.last().getByRole("link").click();
  await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades\/20$/);
});

test("o clique numa Fonte da lista do Acervo cai na página da Fonte (ACER-01)", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/acervo");
  await page.getByRole("link", { name: "Antiguidades Judaicas" }).click();
  await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Antiguidades Judaicas" }),
  ).toBeVisible();
  await expect(page.locator('[data-slot="bloco-proveniencia"]')).toBeVisible();
});

test("o aviso de tradução aparece acima do bloco de proveniência na Fonte traduzida por nós", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(`/acervo/${extras["fonte-traduzida-teste"]}`);
  const aviso = page.getByRole("status").filter({ hasText: AVISO });
  await expect(aviso).toBeVisible();
  await expect(aviso).toContainText("Aviso.");
  await expect(aviso).toContainText("Confira com a edição de referência antes de citar.");
  const bloco = page.locator('[data-slot="bloco-proveniencia"]');
  const [a, b] = [await aviso.boundingBox(), await bloco.boundingBox()];
  expect((a?.y ?? 0) + (a?.height ?? 0)).toBeLessThanOrEqual((b?.y ?? 0) + 1);
  await expect(bloco).toContainText("Tradução feita por nós");
  await expect(bloco).toContainText("Equipe de teste, 2026");
  await expect(bloco).toContainText("Domínio público, dedicado pelo tradutor");
});

test("endereço de origem muito longo quebra sem estourar a largura", async ({ page }) => {
  await entrar(page);
  await page.goto(`/acervo/${extras["fonte-traduzida-teste"]}`);
  const origem = page
    .locator('[data-slot="bloco-proveniencia"]')
    .getByRole("link", { name: /texto-integral-sem-quebra/ });
  await expect(origem).toBeVisible();
  expect(await semRolagemHorizontal(page)).toBe(true);
  const caixa = await origem.boundingBox();
  const largura = page.viewportSize()?.width ?? 0;
  expect((caixa?.x ?? 0) + (caixa?.width ?? 0)).toBeLessThanOrEqual(largura);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("obra de uma só seção mostra o texto na própria página, sem sumário", async ({ page }) => {
  await entrar(page);
  await page.goto(`/acervo/${extras["fonte-uma-secao-teste"]}`);
  await expect(page.getByRole("heading", { level: 2, name: "Texto", exact: true })).toBeVisible();
  await expect(page.locator('[data-slot="sumario"]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Seções/ })).toHaveCount(0);
  const paragrafo = page.locator("#p-18\\.63");
  await expect(paragrafo).toContainText("wise man");
  // Texto em inglês dentro de página em português: lang no elemento e hifenização só por ele.
  await expect(paragrafo).toHaveAttribute("lang", "en");
  expect(await paragrafo.evaluate((el) => getComputedStyle(el).hyphens)).toBe("auto");
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
  // O resumo auxiliar vem logo antes do texto, com o rótulo sempre visível.
  const resumo = page.locator('[data-slot="resumo-auxiliar"]');
  await expect(resumo).toBeVisible();
  await expect(resumo).toContainText(
    "Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado.",
  );
  await expect(resumo).toHaveAttribute("lang", "pt-BR");
  await expect(page.getByText(AVISO)).toHaveCount(0);
  await expect(page.getByText("Domínio público (tradução anterior a 1929)")).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("Fonte sem limites não mostra a seção nem título solto", async ({ page }) => {
  await entrar(page);
  await page.goto(`/acervo/${extras["fonte-sem-limites-teste"]}`);
  await expect(
    page.getByRole("heading", { level: 1, name: "Fonte sem limites, de teste" }),
  ).toBeVisible();
  await expect(page.getByText("O que esta Fonte não pode dizer")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Seções (2)" })).toBeVisible();
  await expect(
    page.locator('[data-slot="bloco-proveniencia"] dt').filter({ hasText: "Licença" }),
  ).toBeVisible();
  await expect(page.locator('[data-slot="bloco-proveniencia"]')).toContainText("CC BY 4.0");
  // Sem tradutor, edição nem tradução própria, a linha "Tradução" não existe.
  await expect(page.locator('[data-slot="bloco-proveniencia"] dt')).toHaveText([
    "Nível de fonte",
    "Origem do texto",
    "Licença",
    "Idioma do texto",
  ]);
});

test("Fonte inexistente, não publicada ou de ficha mostram 'Página não encontrada'", async ({
  page,
}) => {
  await entrar(page);
  for (const slug of ["nao-existe", slugRascunho, slugFicha]) {
    await page.goto(`/acervo/${slug}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeVisible();
  }
  await expect(page.getByText("Rascunho de teste")).toHaveCount(0);
});

test("título, resumo e limites de Fonte são texto: a marcação aparece literal", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(`/acervo/${slugMarcado}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(MARCADO);
  await expect(page.locator("#intruso")).toHaveCount(0);
  await expect(page.locator("article b, article img")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
});

test("@varredura passo 5: a Fonte não rola na horizontal com o texto no maior tamanho", async ({
  page,
  baseURL,
}) => {
  await page
    .context()
    .addCookies([{ name: "escala-texto", value: "5", url: baseURL ?? "http://localhost" }]);
  await entrar(page);
  for (const caminho of [
    "/acervo/josefo-antiguidades",
    `/acervo/${extras["fonte-traduzida-teste"]}`,
    `/acervo/${extras["fonte-uma-secao-teste"]}`,
  ]) {
    await page.goto(caminho);
    await expect(page.locator("article h1")).toBeVisible();
    expect(await semRolagemHorizontal(page)).toBe(true);
  }
});
