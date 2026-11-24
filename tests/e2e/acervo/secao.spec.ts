import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { removerExtras, type SlugsExtras, semearExtras } from "../../support/acervo-extras";
import { convidarParaTeste, emailDeTeste, entrarPorLink, escrever } from "../../support/login-e2e";

// Leitura de uma seção de Fonte (ACER-02, ACER-04): o Estudante abre /acervo/<fonte>/<seção>#p-<ref> e lê o
// parágrafo com a referência e o crédito do texto. O texto da Fonte é sempre texto, nunca marcação. Roda
// sobre o recorte real do Josefo semeado por `scripts/dev/e2e.ts` (tests/fixtures/acervo).

// As Fontes de teste da seção (traduzida por nós, sem resumo) entram por arquivo e saem no fim; um arquivo, um
// processo, para o `afterAll` de um não tirar a Fonte de quem ainda a usa. O sufixo é o do projeto.
test.describe.configure({ mode: "default" });
let extras: SlugsExtras;
// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  extras = await semearExtras(`sec-${info.project.name}`);
});
// biome-ignore lint/correctness/noEmptyPattern: idem
test.afterAll(async ({}, info) => {
  await removerExtras(`sec-${info.project.name}`);
  await escrever("delete from acervo.fonte_paragrafo where secao_id = $1 || '/1'", [
    slugLonga(info.project.name),
  ]);
  await escrever("delete from acervo.fonte_secao where id = $1 || '/1'", [
    slugLonga(info.project.name),
  ]);
  await escrever("delete from acervo.fonte where slug = $1", [slugLonga(info.project.name)]);
});

const slugLonga = (projeto: string) => `fonte-longa-e2e-${projeto}`;

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("acervo");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

// Fontes extras de teste, só deste arquivo; `on conflict` porque os dois projetos (celular e computador)
// rodam o mesmo arquivo contra o mesmo banco.
async function semearFonteExtra(slug: string, publicada: boolean, texto: string): Promise<void> {
  await escrever(
    `insert into acervo.fonte (slug, nivel, titulo, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
     values ($1, 'primaria', 'Fonte extra de teste', 'integral', 'en', 'dominio-publico', 'Origem de teste',
             'https://exemplo.org/', $2::boolean)
     on conflict (slug) do nothing`,
    [slug, String(publicada)],
  );
  await escrever(
    `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo)
     select $1 || '/1', id, '1', 1, 'Seção única' from acervo.fonte where slug = $1
     on conflict (id) do nothing`,
    [slug],
  );
  await escrever(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
     values ($1 || '/1.1', $1 || '/1', 1, $2, '1.1', 'en')
     on conflict (id) do nothing`,
    [slug, texto],
  );
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

test("lê o parágrafo 18.63 com a referência, o crédito e o parágrafo-alvo destacado", async ({
  page,
}) => {
  const hidratacao = vigiarHidratacao(page);
  await entrar(page);
  await page.goto("/acervo/josefo-antiguidades/18#p-18.63");

  await expect(page.getByRole("heading", { level: 1, name: "Livro 18" })).toBeVisible();
  const paragrafo = page.locator("#p-18\\.63");
  await expect(paragrafo).toContainText("wise man");
  await expect(paragrafo).toContainText("18.63");
  await expect(paragrafo).toHaveAttribute("lang", "en");
  // O leitor de tela ouve "Parágrafo 18.63" (a referência não é link).
  await expect(paragrafo.locator(".sr-only")).toHaveText("Parágrafo ");
  await expect(paragrafo.getByRole("link")).toHaveCount(0);

  // O Nível é texto e forma (contorno), nunca só cor.
  const selo = page.locator('[data-slot="selo-nivel"]');
  await expect(selo).toHaveText("Fonte primária");
  await expect(selo).toHaveCSS("border-top-style", "solid");

  // O rótulo do resumo auxiliar está visível sem tocar em nada (D-18).
  await expect(
    page.getByText("Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado."),
  ).toBeVisible();

  // Crédito do texto.
  await expect(page.getByText("Texto: Perseus Digital Library.")).toContainText(
    "Licença: Edição digital: CC BY-SA. Tradução de William Whiston, 1737: domínio público.",
  );

  // Parágrafo-alvo do endereço: forma (preenchimento e filete), não cor.
  const estilo = (el: Element) => {
    const css = getComputedStyle(el);
    return { fundo: css.backgroundColor, sombra: css.boxShadow };
  };
  const alvo = await paragrafo.evaluate(estilo);
  expect(alvo.fundo).not.toBe("rgba(0, 0, 0, 0)");
  // Filete esquerdo de 2 px (sombra interna sem desfoque, só no lado esquerdo): forma, não cor.
  expect(alvo.sombra).toMatch(/inset/);
  expect(alvo.sombra).toMatch(/\b2px 0px 0px 0px\b/);
  // Controle negativo: sem o endereço com âncora, o mesmo parágrafo não tem preenchimento nem filete.
  await page.goto("/acervo/josefo-antiguidades/18");
  const sem = await page.locator("#p-18\\.63").evaluate(estilo);
  expect(sem.fundo).toBe("rgba(0, 0, 0, 0)");
  expect(sem.sombra).toBe("none");
  await page.goto("/acervo/josefo-antiguidades/18#p-18.63");
  await expect(page.locator("#p-18\\.63")).toBeVisible();

  // Sem aviso de hidratação, e sem rolagem horizontal.
  expect(hidratacao).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("navega entre as seções e marca os extremos sem mudar os botões de lugar", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/acervo/josefo-antiguidades/18");
  await expect(page.getByText("seção 1 de 2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Seção anterior" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByText("Primeira seção")).toBeVisible();
  const caixas = async () => ({
    anterior: await page.getByText("Seção anterior").boundingBox(),
    proxima: await page.getByText("Próxima seção").boundingBox(),
  });
  const primeira = await caixas();
  await page.getByRole("link", { name: "Próxima seção" }).click();
  await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades\/20$/);
  await expect(page.locator("#p-20\\.197")).toContainText("brother of Jesus");
  await expect(page.getByRole("button", { name: "Próxima seção" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.getByText("Última seção")).toBeVisible();
  // Os botões não mudam de coluna nem de largura entre o primeiro e o último; os dois têm 44 px de altura.
  const ultima = await caixas();
  expect(Math.round(ultima.anterior?.x ?? -1)).toBe(Math.round(primeira.anterior?.x ?? -2));
  expect(Math.round(ultima.proxima?.x ?? -1)).toBe(Math.round(primeira.proxima?.x ?? -2));
  const alturas = await page
    .locator('nav[aria-label="Seções desta Fonte"] a, nav[aria-label="Seções desta Fonte"] button')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(alturas.every((h) => h >= 44)).toBe(true);
});

test("Fonte inexistente, seção inexistente e Fonte não publicada mostram 'Página não encontrada'", async ({
  page,
}) => {
  await semearFonteExtra("fonte-rascunho-e2e", false, "Texto de uma Fonte não publicada.");
  await entrar(page);
  for (const caminho of [
    "/acervo/nao-existe/1",
    "/acervo/josefo-antiguidades/99",
    "/acervo/fonte-rascunho-e2e/1",
  ]) {
    await page.goto(caminho);
    await expect(
      page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeVisible();
    await expect(page.getByText("Texto de uma Fonte não publicada.")).toHaveCount(0);
  }
});

test("o texto da Fonte é sempre texto: marcação aparece literal e não vira elemento", async ({
  page,
}) => {
  const marcado = `Texto com <b id="intruso">marcação</b> e <img src="x" onerror="window.__xss=1"> no meio.`;
  await semearFonteExtra("fonte-marcacao-e2e", true, marcado);
  await entrar(page);
  await page.goto("/acervo/fonte-marcacao-e2e/1");
  const paragrafo = page.locator("#p-1\\.1");
  await expect(paragrafo).toContainText(marcado);
  await expect(page.locator("#intruso")).toHaveCount(0);
  await expect(paragrafo.locator("b, img")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
});

test("@varredura passo 5: a seção não rola na horizontal com o texto no maior tamanho", async ({
  page,
  baseURL,
}) => {
  await page
    .context()
    .addCookies([{ name: "escala-texto", value: "5", url: baseURL ?? "http://localhost" }]);
  await entrar(page);
  for (const caminho of ["/acervo/josefo-antiguidades/18", "/acervo/josefo-antiguidades/20"]) {
    await page.goto(caminho);
    await expect(page.locator("article h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
});

test("seção sem resumo não deixa bloco nem título solto; seção com resumo mostra o rótulo sem interação", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(`/acervo/${extras["fonte-sem-limites-teste"]}/18`);
  await expect(page.getByRole("heading", { level: 1, name: "Seção sem resumo" })).toBeVisible();
  await expect(page.locator('[data-slot="resumo-auxiliar"]')).toHaveCount(0);
  await expect(page.getByText("Resumo auxiliar")).toHaveCount(0);
  await expect(page.getByText("Palavras-chave")).toHaveCount(0);

  await page.goto(`/acervo/${extras["fonte-traduzida-teste"]}/18`);
  const resumo = page.locator('[data-slot="resumo-auxiliar"]');
  await expect(resumo).toBeVisible();
  // Nunca recolhido: o rótulo está no DOM visível, fora de qualquer elemento que feche.
  await expect(resumo.locator("details, [aria-expanded], [hidden]")).toHaveCount(0);
  await expect(resumo.getByText("Resumo auxiliar", { exact: true })).toBeVisible();
  await expect(
    resumo.getByText("Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado."),
  ).toBeVisible();
  await expect(resumo).toContainText("Palavras-chave: teste, rótulo");
  await expect(resumo).toHaveAttribute("lang", "pt-BR");
});

test("o aviso de tradução vem acima do resumo e do texto da seção traduzida por nós", async ({
  page,
}) => {
  await entrar(page);
  await page.goto(`/acervo/${extras["fonte-traduzida-teste"]}/18`);
  const aviso = page.getByRole("status").filter({ hasText: "Esta tradução foi feita por nós" });
  await expect(aviso).toBeVisible();
  const [a, r, t] = [
    await aviso.boundingBox(),
    await page.locator('[data-slot="resumo-auxiliar"]').boundingBox(),
    await page.locator('[data-slot="texto-da-fonte"]').boundingBox(),
  ];
  expect(a?.y ?? 0).toBeLessThan(r?.y ?? 0);
  expect(r?.y ?? 0).toBeLessThan(t?.y ?? 0);
  // O crédito do rodapé liga à proveniência da página da Fonte.
  await expect(page.getByRole("link", { name: "Origem e licença" })).toHaveAttribute(
    "href",
    `/acervo/${extras["fonte-traduzida-teste"]}#origem`,
  );
});

test("o link com âncora leva ao parágrafo mesmo numa seção longa, chegando de outra página", async ({
  page,
}, info) => {
  const slug = slugLonga(info.project.name);
  await escrever(
    `insert into acervo.fonte (slug, nivel, titulo, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
     values ($1, 'primaria', 'Fonte longa de teste', 'integral', 'en', 'dp-dedicado', 'Origem de teste',
             'https://exemplo.org/', true) on conflict (slug) do nothing`,
    [slug],
  );
  await escrever(
    `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo)
     select $1 || '/1', id, '1', 1, 'Seção longa' from acervo.fonte where slug = $1
     on conflict (id) do nothing`,
    [slug],
  );
  await escrever(
    `insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
     select $1 || '/1.' || n, $1 || '/1', n, 'Parágrafo ' || n || ' ' || repeat('palavra de teste ', 80), '1.' || n, 'en'
     from generate_series(1, 80) as n on conflict (id) do nothing`,
    [slug],
  );
  await entrar(page);
  // Como um link de Citação: de outra página, com carga completa até o parágrafo 1.70.
  await page.goto("/acervo");
  await page.goto(`/acervo/${slug}/1#p-1.70`);
  const alvo = page.locator("#p-1\\.70");
  await expect(alvo).toBeVisible();
  await expect
    .poll(() => alvo.evaluate((el) => Math.round(el.getBoundingClientRect().top)), {
      timeout: 10_000,
    })
    .toBeLessThan(page.viewportSize()?.height ?? 0);
  expect(await alvo.evaluate((el) => el.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
});
