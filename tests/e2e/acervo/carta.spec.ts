import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { lerCarta } from "../../../src/modules/acervo/carta";
import { dataPorExtenso } from "../../../src/modules/privacidade/aviso";
import { removerFichas, semearFichas } from "../../support/ficha-e2e";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Carta de neutralidade (D-08, UI-SPEC tela 7). O texto é do dono e NÃO existe no produto enquanto ele não o publicar:
// no e2e comum a carta está ausente e a prova é "rota 404 e link ausente" (mesmo com ficha verificada na lista). O estado
// "com carta" roda só quando `CARTA_DIR_PARA_TESTE` aponta para a pasta de fixture (a variável é ignorada em produção):
//   CARTA_DIR_PARA_TESTE=tests/fixtures/acervo/carta/valida pnpm test:e2e tests/e2e/acervo/carta.spec.ts
// O texto da fixture é inventado.

test.describe.configure({ mode: "default" });

// Presença medida pelo mesmo leitor do produto: vale para a fixture e para o arquivo real publicado pelo dono.
const COM_CARTA = lerCarta() !== null;
let sufixo = "";
let slugFicha = "";

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = `carta-${info.project.name}`;
  // Uma ficha verificada na lista: o link só existe com a carta E com ficha, então a ausência precisa ser provada
  // COM ficha (do contrário "sem link" valeria só por falta de ficha).
  slugFicha = (await semearFichas(sufixo)).slugs.completa;
});

test.afterAll(async () => {
  if (sufixo) await removerFichas(sufixo);
});

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("acervo-carta");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

const LINK = /Por que estas obras\?/;

test.describe("sem a carta publicada", () => {
  test.skip(COM_CARTA, "estado sem carta: só sem a carta publicada");

  test("a rota da carta mostra 'Página não encontrada'", async ({ page }) => {
    await entrar(page);
    await page.goto("/acervo/carta-de-neutralidade");
    await expect(
      page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeVisible();
    await expect(page.locator('[data-slot="carta"]')).toHaveCount(0);
  });

  test("o link 'Por que estas obras?' não aparece na lista nem na ficha, mesmo havendo ficha verificada", async ({
    page,
  }) => {
    await entrar(page);
    await page.goto("/acervo");
    await expect(page.getByRole("heading", { level: 1, name: "Acervo" })).toBeVisible();
    // Controle positivo: a ficha verificada está na lista (a condição "há ficha" está satisfeita).
    await expect(page.locator(`a[href="/acervo/${slugFicha}"]`)).toBeVisible();
    await expect(page.getByRole("link", { name: LINK })).toHaveCount(0);
    await expect(page.locator('[data-slot="link-da-carta"]')).toHaveCount(0);

    await page.goto(`/acervo/${slugFicha}`);
    await expect(
      page.getByRole("heading", { level: 1, name: "Obra de Teste Completa" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: LINK })).toHaveCount(0);
  });
});

test.describe("com a carta publicada (fixture)", () => {
  test.skip(!COM_CARTA, "estado com carta: só com a carta publicada (fixture ou arquivo do dono)");

  test("a página mostra o h1, as seções e a versão e a data do que foi publicado; texto é texto", async ({
    page,
  }) => {
    // Nada do conteúdo da carta é fixo no teste (título, seções, versão, data, texto): tudo vem do `lerCarta()`, o
    // mesmo leitor do produto, então vale para qualquer fixture e para a carta que o dono vai escrever.
    const carta = lerCarta();
    expect(carta).not.toBeNull();
    if (!carta) return;
    await entrar(page);
    await page.goto("/acervo/carta-de-neutralidade");
    await expect(page.getByRole("heading", { level: 1, name: carta.titulo })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(
      carta.secoes.map((s) => s.titulo),
    );
    await expect(page.locator('[data-slot="versao-da-carta"]')).toHaveText(
      `Carta versão ${carta.versao}, de ${dataPorExtenso(carta.data)}.`,
    );
    // O texto aparece inteiro, como texto: nenhum elemento de marcação nasce do conteúdo do arquivo.
    const corpo = page.locator('[data-slot="carta"]');
    for (const p of [...carta.lede, ...carta.secoes.flatMap((s) => s.paragrafos)])
      await expect(corpo).toContainText(p);
    await expect(corpo.locator("b, i, em, strong, img, script, iframe")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Voltar ao Acervo" })).toHaveAttribute(
      "href",
      "/acervo",
    );
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.passes.length).toBeGreaterThan(10);
    expect(axe.violations.map((v) => v.id)).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("o link aparece na lista e na ficha e leva à carta", async ({ page }) => {
    await entrar(page);
    await page.goto("/acervo");
    const link = page.getByRole("link", { name: LINK });
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", "/acervo/carta-de-neutralidade");
    await link.click();
    await expect(
      page.getByRole("heading", { level: 1, name: lerCarta()?.titulo ?? "" }),
    ).toBeVisible();

    await page.goto(`/acervo/${slugFicha}`);
    await expect(page.getByRole("link", { name: LINK })).toHaveCount(1);
  });
});
