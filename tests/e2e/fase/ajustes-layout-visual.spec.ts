import { mkdirSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { algarismosEmVersalete } from "../../support/algarismos-em-versalete";
import { esperarEstudoAssentado, usarVozImediata } from "../../support/estudo-assentado";
import { type FichasSemeadas, removerFichas, semearFichas } from "../../support/ficha-e2e";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Conferência RENDERIZADA dos ajustes de layout (plano 02-ajustes; rule `visual-verification-gate`): a linha de
// voz do Ouvir sem deslocar o Estudo, o esqueleto da Leitura e os algarismos fora do versalete nos Rótulos.
// Roda só com `VISUAL_DIR` (pasta das capturas); o critério está em
// `.planning/phases/02-acervo/visual/ajustes-layout.md`. Em cada tela, em cada largura e tema:
//   (a) sem rolagem horizontal; (b) axe sem violações; (c) nenhum algarismo em versalete;
//   (d) captura da tela e recorte ampliado do Rótulo com algarismo, para ler a olho.
//   VISUAL_DIR=<pasta> pnpm test:e2e tests/e2e/fase/ajustes-layout-visual.spec.ts --project=varredura-320-claro ...

const PASTA = process.env.VISUAL_DIR;
test.skip(!PASTA, "conferência visual só com VISUAL_DIR");
test.describe.configure({ mode: "default" });
// Recorte ampliado: o algarismo do Rótulo é pequeno, e o que se confere é o desenho dele.
test.use({ deviceScaleFactor: 2 });

let sufixo = "";
let semeadas: FichasSemeadas;
// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = `ajl-${info.project.name}`;
  semeadas = await semearFichas(sufixo);
});
test.afterAll(async () => {
  if (sufixo) await removerFichas(sufixo);
});

type Alvo = {
  id: string;
  rota: () => string;
  espera: (page: Page) => Promise<void>;
  /** Rótulos com algarismo que se recortam para a leitura a olho. */
  rotulos: string[];
};

const ALVOS: Alvo[] = [
  {
    id: "ficha",
    rota: () => `/acervo/${semeadas.slugs.completa}`,
    espera: async (page) => {
      await expect(page.locator('[data-slot="item-de-ficha"]').first()).toBeVisible();
    },
    rotulos: ['[data-slot="pagina-do-item"]', '[data-slot="verificacao"] p'],
  },
  {
    id: "fonte-secao",
    rota: () => "/acervo/josefo-antiguidades/18",
    espera: async (page) => {
      await expect(page.locator("#p-18\\.63")).toBeVisible();
    },
    rotulos: ['[data-slot="paragrafo-fonte"] [lang="pt-BR"]'],
  },
  {
    id: "estudo",
    rota: () => "/estudos/batismo-e-tentacao",
    espera: async (page) => {
      await esperarEstudoAssentado(page);
    },
    rotulos: ["article > header > p"],
  },
  {
    id: "trilhas",
    rota: () => "/trilhas",
    espera: async (page) => {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    },
    rotulos: ['[data-slot="accordion-trigger"] span.text-label'],
  },
];

for (const variante of ["projeto", "390-claro"] as const) {
  test(`@varredura ajustes de layout${variante === "projeto" ? "" : " (390-claro)"}`, async ({
    page,
  }, info) => {
    test.setTimeout(240_000);
    if (variante === "390-claro") {
      test.skip(info.project.name !== "varredura-390-escuro", "variante só no projeto de 390 px");
      await page.emulateMedia({ colorScheme: "light" });
    }
    const nome = variante === "390-claro" ? "varredura-390-claro" : info.project.name;
    mkdirSync(PASTA as string, { recursive: true });
    await usarVozImediata(page);
    const email = emailDeTeste(`visual-ajl-${nome}`);
    await convidarParaTeste(email);
    await entrarPorLink(page, email);

    for (const alvo of ALVOS) {
      await page.goto(alvo.rota());
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
      await alvo.espera(page);

      const sobra = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sobra, `${alvo.id}: rolagem horizontal`).toBeLessThanOrEqual(0);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(
        axe.violations.map((v) => `${v.id}: ${v.nodes.length}`),
        `${alvo.id}: axe`,
      ).toEqual([]);
      expect(await algarismosEmVersalete(page), `${alvo.id}: algarismo em versalete`).toEqual([]);

      await page.screenshot({
        path: path.join(PASTA as string, `ajustes-${alvo.id}-${nome}.png`),
        fullPage: true,
      });
      for (const [i, seletor] of alvo.rotulos.entries()) {
        const rotulo = page.locator(seletor).first();
        if ((await rotulo.count()) === 0) continue;
        await rotulo.scrollIntoViewIfNeeded();
        await rotulo.screenshot({
          path: path.join(PASTA as string, `ajustes-${alvo.id}-rotulo${i + 1}-${nome}.png`),
        });
      }
    }
  });
}
