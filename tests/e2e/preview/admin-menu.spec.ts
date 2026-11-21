import { expect, test } from "@playwright/test";
import {
  abrirSessao,
  apagarDadosPrivados,
  desabilitarCanarios,
  habilitarCanarios,
  prepararAdmin,
} from "./suporte-canario";

// Achado do plano 01-19: na navegação das telas de Estudante, o item "Convites" do Admin apontava para
// /convites (rota que não existe, 404). A rota é /admin/convites. Este teste prova o link PELA TELA do
// Estudante (Trilhas), onde o defeito morava; o e2e local de `tests/e2e/admin/convites.spec.ts` guarda
// o conserto na fonte.

test.beforeAll(async () => {
  await habilitarCanarios(["admin"]);
  await apagarDadosPrivados("admin");
});

test.afterAll(async () => {
  await desabilitarCanarios(["admin"]);
});

test("Admin: o link Convites da navegação das Trilhas abre a lista de convites", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const s = await abrirSessao(browser, "admin", baseURL as string, { width: 1280, height: 800 });
  try {
    const page = await s.contexto.newPage();
    await prepararAdmin(page);
    await page.goto("/trilhas");
    await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Seções" })
      .getByRole("link", { name: "Convites" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Convites" })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await s.encerrar();
  }
});
