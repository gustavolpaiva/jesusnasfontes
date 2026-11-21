import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink, escrever } from "../../support/login-e2e";
import { entrarComo, prepararTela, slugDeCapitulo, TELAS } from "./telas";

// UI-04 (plano 01-19): em escala de cinza o estado ainda se distingue. (1) Captura com o filtro nas telas
// com mensagem de status, grade de capítulos e lista de convites, em `test-results/cinza/`. (2) Os pares
// que a cor não pode carregar sozinha diferem por FORMA nos nós do DOM: erro e acento (ícone e palavra),
// concluído e por fazer (marca e palavra), e os três estados de convite (palavra e borda).

const CINZA = "html { filter: grayscale(1) !important; }";

for (const tela of TELAS.filter((t) => t.cinza)) {
  test(`cinza: captura de ${tela.id}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    mkdirSync("test-results/cinza", { recursive: true });
    await prepararTela(page, tela);
    await page.addStyleTag({ content: CINZA });
    const filtro = await page.evaluate(() => getComputedStyle(document.documentElement).filter);
    expect(filtro).toContain("grayscale");
    await page.screenshot({
      path: `test-results/cinza/${tela.id}-${info.project.name}.png`,
      fullPage: true,
    });
  });
}

type Forma = { icone: string; palavra: string; filete: string };

async function formaDaMensagem(
  page: Page,
  papel: "alert" | "status",
  palavra: string,
): Promise<Forma> {
  const m = page.getByRole(papel).filter({ hasText: palavra }).first();
  await expect(m).toBeVisible();
  return m.evaluate((el) => ({
    icone:
      [...(el.querySelector("svg")?.classList ?? [])].find((c) => c.startsWith("lucide-")) ?? "",
    palavra: (el.textContent ?? "").trim().split(/\s/)[0] ?? "",
    filete: getComputedStyle(el).borderLeftWidth,
  }));
}

test("cinza: erro e acento diferem por ícone e por palavra, não só por cor", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  // Acento (Feito.): concluir um Estudo.
  await entrarComo(page, "estudante");
  await page.goto("/estudos/batismo-e-tentacao");
  const concluir = page.getByRole("button", { name: "Marcar como concluído" });
  await esperarHidratado(concluir);
  await concluir.click();
  const acento = await formaDaMensagem(page, "status", "Feito.");
  // Erro (Erro.): e-mail malformado na entrada, num contexto sem sessão.
  const outro = await browser.newContext({ baseURL });
  try {
    const p2 = await outro.newPage();
    await p2.goto("/entrar");
    const campo = p2.getByLabel("E-mail");
    await esperarHidratado(campo);
    await campo.fill("sem-arroba");
    await p2.getByRole("button", { name: "Enviar acesso" }).click();
    const erro = await formaDaMensagem(p2, "alert", "Erro.");
    expect(erro.icone).not.toBe("");
    expect(acento.icone).not.toBe("");
    expect(erro.icone).not.toBe(acento.icone);
    expect(erro.palavra).not.toBe(acento.palavra);
  } finally {
    await outro.close();
  }
});

test("cinza: concluído e por fazer diferem por marca e por palavra, na lista e na grade", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = emailDeTeste("cinza-c");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  // Conclui o primeiro Estudo da Base histórica e um capítulo da Leitura contínua.
  const slugs = ["o-que-a-historia-consegue-afirmar", await slugDeCapitulo()];
  for (const slug of slugs) {
    await page.goto(`/estudos/${slug}`);
    const concluir = page.getByRole("button", { name: "Marcar como concluído" });
    await esperarHidratado(concluir);
    await concluir.click();
    await expect(page.getByRole("status").filter({ hasText: "Estudo concluído." })).toBeVisible({
      timeout: 20_000,
    });
  }
  await page.goto("/trilhas");
  const leitura = page.getByRole("button", { name: /Leitura contínua/ });
  await esperarHidratado(leitura);
  if ((await leitura.getAttribute("aria-expanded")) !== "true") await leitura.click();
  await expect(page.locator("a[data-estado]").first()).toBeVisible();
  // Grade: a casa concluída tem a marca (ícone) e a palavra no nome; a por fazer não tem nenhuma.
  const grade = await page.locator("a[data-estado]").evaluateAll((els) =>
    els.map((el) => ({
      estado: el.getAttribute("data-estado"),
      marca: !!el.querySelector("svg"),
      palavra: /concluído/.test(el.getAttribute("aria-label") ?? ""),
      borda: getComputedStyle(el).borderTopWidth,
    })),
  );
  const concluida = grade.find((g) => g.estado === "atual-concluida" || g.estado === "concluida");
  const porFazer = grade.find((g) => g.estado === "por-fazer");
  expect(concluida, "casa concluída na grade").toBeTruthy();
  expect(porFazer, "casa por fazer na grade").toBeTruthy();
  expect(concluida?.marca).toBe(true);
  expect(concluida?.palavra).toBe(true);
  expect(porFazer?.marca).toBe(false);
  expect(porFazer?.palavra).toBe(false);
  // Lista da Base histórica nas Trilhas: a linha concluída tem o ícone e ", concluído" para o leitor.
  const base = page.getByRole("button", { name: /Base histórica/ });
  await esperarHidratado(base);
  if ((await base.getAttribute("aria-expanded")) !== "true") await base.click();
  const concluidaNaLista = page
    .getByRole("link", { name: /O que a história consegue afirmar/ })
    .first();
  await expect(concluidaNaLista).toBeVisible();
  expect(await concluidaNaLista.locator("svg").count()).toBeGreaterThan(0);
  await expect(concluidaNaLista).toContainText("concluído");
  const outra = page
    .getByRole("list")
    .getByRole("link")
    .filter({ hasNotText: "concluído" })
    .first();
  expect(await outra.locator("svg").count()).toBe(0);
});

test("cinza: os três estados de convite diferem por palavra e por borda", async ({ page }) => {
  test.setTimeout(120_000);
  await entrarComo(page, "admin");
  await page.goto("/admin/convites");
  await expect(page.getByRole("heading", { level: 1, name: "Convites" })).toBeVisible();
  const enderecos: Record<string, string> = {};
  for (const [estado, sql] of [
    ["pendente", null],
    [
      "aceito",
      "update admin.convite set estado = 'aceito', aceito_em = now() where email_norm = $1",
    ],
    [
      "revogado",
      "update admin.convite set estado = 'revogado', revogado_em = now() where email_norm = $1",
    ],
  ] as const) {
    const e = emailDeTeste(`cinza-${estado}`);
    enderecos[estado] = e;
    await page.getByLabel("E-mail da pessoa").fill(e);
    await page.getByRole("button", { name: "Convidar" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: e })).toBeVisible();
    if (sql) await escrever(sql, [e.toLowerCase()]);
  }
  await page.goto("/admin/convites");
  const rotulos: string[] = [];
  const bordas: string[] = [];
  for (const [estado, palavra] of [
    ["pendente", "Pendente"],
    ["aceito", "Aceito"],
    ["revogado", "Revogado"],
  ] as const) {
    const chip = page
      .getByRole("listitem")
      .filter({ hasText: enderecos[estado] as string })
      .getByText(palavra, { exact: true });
    await expect(chip).toBeVisible();
    rotulos.push((await chip.textContent()) ?? "");
    bordas.push(await chip.evaluate((el) => getComputedStyle(el).borderTopStyle));
  }
  expect(new Set(rotulos).size, "uma palavra diferente por estado").toBe(3);
  // Pendente tem borda tracejada; Aceito, sólida: a forma da moldura separa os dois sem cor.
  expect(bordas[0]).not.toBe(bordas[1]);
});
