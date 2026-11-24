import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { procurarNoLog } from "../../support/captura-logs";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// PRIV-04: o termo buscado no Acervo não aparece na URL, no título da página nem nos registros do servidor, pelos
// dois caminhos da interface (o campo da lista e o campo da própria tela de busca). O que alguém procura sobre a fé
// pode revelar crença religiosa: a busca é um POST e o termo vai só no corpo da requisição.

const buscar = (page: Page) => page.getByRole("button", { name: "Buscar", exact: true });
const campo = (page: Page) => page.getByRole("searchbox", { name: "Buscar no Acervo" });

test("o termo buscado, pela lista e pela tela de busca, não vai à URL nem ao registro do servidor", async ({
  page,
}) => {
  // Só letras: a busca por palavra não parte o termo (um uuid viraria várias palavras).
  const letras = (n: number) =>
    randomUUID()
      .replaceAll(/[^a-f]/g, "")
      .padEnd(n, "x")
      .slice(0, n);
  const pelaLista = `marcadorlista${letras(18)}`;
  const peloCampo = `marcadorcampo${letras(18)}`;
  const controle = `controleacervo${letras(18)}`;
  const urls: string[] = [];
  const titulos: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("framenavigated", (f) => urls.push(f.url()));

  const email = emailDeTeste("acervo-log");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);

  // Controle do instrumento: uma URL com um termo APARECE no registro do servidor. É por isso que a busca é POST.
  await page.goto(`/acervo/busca?controle=${controle}`);
  await expect.poll(() => procurarNoLog(controle)).toBe(true);

  // 1. Pelo campo da lista.
  await page.goto("/acervo");
  await esperarHidratado(buscar(page));
  await campo(page).fill(pelaLista);
  await buscar(page).click();
  await expect(page).toHaveURL(/\/acervo\/busca$/);
  await expect(
    page.getByRole("status").filter({ hasText: `Nenhum resultado para “${pelaLista}”` }),
  ).toBeVisible();
  titulos.push(await page.title());

  // 2. Pelo campo da tela de busca.
  await page.goto("/acervo/busca");
  await esperarHidratado(buscar(page));
  await campo(page).fill(peloCampo);
  await buscar(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Nenhum resultado para “${peloCampo}”` }),
  ).toBeVisible();
  titulos.push(await page.title());
  expect(new URL(page.url()).search).toBe("");

  // Nenhum dos dois termos está no registro do servidor, em URL visitada ou requisitada, nem em título.
  for (const termo of [pelaLista, peloCampo]) {
    expect(procurarNoLog(termo), termo).toBe(false);
    expect(procurarNoLog(encodeURIComponent(termo)), termo).toBe(false);
    expect(
      urls.map((u) => decodeURIComponent(u)).some((u) => u.includes(termo)),
      termo,
    ).toBe(false);
    expect(
      titulos.some((t) => t.includes(termo)),
      termo,
    ).toBe(false);
  }
  expect(urls.length).toBeGreaterThan(5);
  expect(titulos).toHaveLength(2);
});
