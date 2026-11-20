import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { procurarNoLog } from "../../support/captura-logs";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink, escrever } from "../../support/login-e2e";

// PRIV-04: o texto de uma Anotação não aparece nos registros do servidor nem em nenhuma URL, pelos caminhos
// da interface: gravar, buscar, passar do limite e falhar ao gravar. Roda sobre o conteúdo mínimo
// (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

const campo = (page: Page) => page.getByRole("textbox", { name: "Minha anotação" });
const estado = (page: Page) => page.locator('[data-slot="save-status"]');

// Estudo criado só para o teste, em uma Trilha própria, e removido no fim: o teste apaga o Estudo com a
// página aberta, para a gravação falhar por um motivo real do servidor.
async function criarEstudoTemporario(): Promise<{ slug: string; trilha: string }> {
  const id = randomUUID().slice(0, 8);
  const trilha = `trilha-marcador-${id}`;
  const slug = `estudo-marcador-${id}`;
  const ordem = String(1000 + Math.floor(Math.random() * 30000));
  await escrever(
    "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, 'Trilha de teste', $2, 'x')",
    [trilha, ordem],
  );
  await escrever(
    `insert into conteudo.estudo (slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
     values ($1, $2, 1, 'Estudo do marcador', 'devocional', 'x', repeat('a', 64))`,
    [slug, trilha],
  );
  return { slug, trilha };
}

test("o texto escrito, buscado, acima do limite e que falhou ao gravar não vai ao registro nem a URL", async ({
  page,
}) => {
  const marcador = `MARCADOR-${randomUUID()}`;
  const controle = `CONTROLE-${randomUUID()}`;
  const urls: string[] = [];
  const titulos: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  page.on("framenavigated", (f) => urls.push(f.url()));

  const email = emailDeTeste("marc");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);

  // Controle do instrumento: uma URL com um termo APARECE no registro do servidor. É por isso que a busca é POST.
  await page.goto(`/caderno?controle=${controle}`);
  await expect.poll(() => procurarNoLog(controle)).toBe(true);

  // 1. Escrever e salvar.
  await page.goto("/estudos/o-nascimento");
  await esperarHidratado(campo(page));
  await campo(page).fill(`Escrevi ${marcador} num Estudo.`);
  await expect(estado(page)).toHaveText("Salvo");
  titulos.push(await page.title());

  // 2. Buscar pelo marcador.
  await page.goto("/caderno");
  await esperarHidratado(page.getByRole("button", { name: "Buscar", exact: true }));
  await page.getByRole("searchbox", { name: "Buscar nas Anotações" }).fill(marcador);
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
  await expect(page.getByText(`1 Anotação com "${marcador}"`)).toBeVisible();
  // O marcador vira várias palavras na busca (as partes do uuid): cada uma é um destaque.
  await expect(page.locator("mark").first()).toBeVisible();
  titulos.push(await page.title());

  // 3. Passar do limite (o servidor recusa se o navegador o enviasse; aqui a tela nem envia).
  await page.goto("/estudos/batismo-e-tentacao");
  await esperarHidratado(campo(page));
  await campo(page).fill(`${marcador} ${"x".repeat(20_001)}`);
  await expect(estado(page)).toContainText("passou do limite de 20 000 caracteres");
  titulos.push(await page.title());

  // 4. Falha de gravação: o Estudo some do servidor com a página aberta.
  const { slug, trilha } = await criarEstudoTemporario();
  try {
    await page.goto(`/estudos/${slug}`);
    await esperarHidratado(campo(page));
    await escrever("delete from conteudo.estudo where slug = $1", [slug]);
    await campo(page).fill(`Falha ${marcador} ao gravar.`);
    await expect(estado(page)).toContainText("Não foi possível salvar");
    titulos.push(await page.title());
  } finally {
    await escrever("delete from conteudo.estudo where slug = $1", [slug]);
    await escrever("delete from conteudo.trilha where id = $1", [trilha]);
  }

  // O marcador não está no registro do servidor da execução, nem em URL visitada ou requisitada, nem em título.
  expect(procurarNoLog(marcador)).toBe(false);
  expect(procurarNoLog(encodeURIComponent(marcador))).toBe(false);
  const todas = urls.map((u) => decodeURIComponent(u));
  expect(todas.some((u) => u.includes(marcador))).toBe(false);
  expect(urls.length).toBeGreaterThan(5);
  expect(titulos.some((t) => t.includes(marcador))).toBe(false);
  expect(titulos.length).toBe(4);
});
