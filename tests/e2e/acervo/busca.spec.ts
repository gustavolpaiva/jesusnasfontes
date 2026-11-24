import { expect, type Page, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink, escrever } from "../../support/login-e2e";

// Busca do Acervo (ACER-05, tela 3): o Estudante digita uma palavra em português, sem acento, no campo da lista e
// chega à seção em inglês pelo resumo auxiliar; a palavra em inglês acha pelo texto; o filtro de Nível é um radio;
// "Mostrar mais resultados" traz o resto; sem resultado e sem aviso de hidratação. Roda sobre o recorte real do
// Josefo semeado por `scripts/dev/e2e.ts` (o resumo de teste do livro 18 cita Pilatos e os cristãos). As contagens
// são RELATIVAS onde outros arquivos semeiam Fontes no mesmo banco.

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("acervo-busca");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

const campo = (page: Page) => page.getByRole("searchbox", { name: "Buscar no Acervo" });
const buscar = (page: Page) => page.getByRole("button", { name: "Buscar", exact: true });
const resultados = (page: Page) => page.locator('[data-slot="resultado-busca"]');
const doLivro18 = (page: Page) =>
  resultados(page).filter({ has: page.locator('a[href^="/acervo/josefo-antiguidades/18"]') });

async function abrirBusca(page: Page): Promise<void> {
  await page.goto("/acervo/busca");
  await expect(page.getByRole("heading", { level: 1, name: "Buscar no Acervo" })).toBeVisible();
  await esperarHidratado(buscar(page));
}

test("do campo da lista ao resultado, com a palavra sem acento, o termo fora da URL e o resumo rotulado", async ({
  page,
}) => {
  const avisos: string[] = [];
  page.on("console", (m) => {
    if (/hydrat/i.test(m.text())) avisos.push(m.text());
  });
  await entrar(page);
  await page.goto("/acervo");
  await esperarHidratado(buscar(page));
  await campo(page).fill("pilatos");
  await buscar(page).click();

  await expect(page).toHaveURL(/\/acervo\/busca$/);
  await expect(
    page.getByRole("status").filter({ hasText: /resultados? para “pilatos”/ }),
  ).toBeVisible();

  const achado = doLivro18(page).first();
  await expect(achado).toBeVisible();
  await expect(achado).toContainText("Encontrado no resumo em português");
  await expect(achado).toContainText("Resumo auxiliar, escrito por IA");
  await expect(achado).toContainText("Antiguidades Judaicas · Livro 18");
  // O trecho vem do resumo, em português, e a palavra achada é o `<mark>` (texto, não HTML).
  const trecho = achado.locator("p[lang='pt-BR']");
  await expect(trecho.locator("mark")).toHaveText("Pilatos");
  // O termo não está na barra de endereço depois de buscar, e o campo guardou o que a pessoa digitou.
  expect(page.url().toLowerCase()).not.toContain("pilatos");
  expect(new URL(page.url()).search).toBe("");
  await expect(campo(page)).toHaveValue("pilatos");
  // O termo deixado na aba pela lista foi lido e apagado.
  expect(await page.evaluate(() => window.sessionStorage.length)).toBe(0);

  // O título leva à seção.
  await achado.getByRole("link", { name: "Livro 18" }).click();
  await expect(page).toHaveURL(/\/acervo\/josefo-antiguidades\/18/);
  expect(avisos).toEqual([]);
});

test("a tela de busca abre com o foco no campo e a palavra em inglês acha o texto, com lang e a âncora do parágrafo", async ({
  page,
}) => {
  await entrar(page);
  await abrirBusca(page);
  await expect(campo(page)).toBeFocused();
  await campo(page).fill("wonderful");
  await buscar(page).click();

  const achado = doLivro18(page).first();
  await expect(achado).toBeVisible();
  await expect(achado).toContainText("Encontrado no texto em inglês");
  await expect(achado).not.toContainText("Resumo auxiliar, escrito por IA");
  const trecho = achado.locator("p[lang='en']");
  await expect(trecho.locator("mark")).toHaveText("wonderful");
  await expect(achado.getByRole("link", { name: "Livro 18" })).toHaveAttribute(
    "href",
    "/acervo/josefo-antiguidades/18#p-18.63",
  );
  // HTML dentro do trecho nunca vira elemento: só `mark` e texto.
  expect(await trecho.locator("*:not(mark):not(span)").count()).toBe(0);
});

test("o filtro de Nível é um radiogroup: marca por forma, vale na hora e exclui o outro Nível", async ({
  page,
}) => {
  await entrar(page);
  await abrirBusca(page);
  const grupo = page.getByRole("radiogroup", { name: "Nível de fonte" });
  await expect(grupo).toBeVisible();
  const todos = grupo.getByRole("radio", { name: "Todos os Níveis" });
  await expect(todos).toHaveAttribute("aria-checked", "true");
  // Seleção por forma (preenchimento invertido e o `check`), não só cor.
  await expect(todos.locator("svg")).toHaveCount(1);

  await campo(page).fill("pilatos");
  await buscar(page).click();
  await expect(doLivro18(page).first()).toBeVisible();

  const primaria = grupo.getByRole("radio", { name: /^Fonte primária/ });
  await primaria.click();
  await expect(primaria).toHaveAttribute("aria-checked", "true");
  await expect(todos).toHaveAttribute("aria-checked", "false");
  await expect(doLivro18(page).first()).toBeVisible();
  for (const selo of await resultados(page).locator('[data-slot="selo-nivel"]').allInnerTexts()) {
    expect(selo).toBe("Fonte primária");
  }

  // Todo outro Nível oferecido tira o Josefo (que é Fonte primária) do resultado.
  const outros = grupo.getByRole("radio", { name: /^(Pesquisa acadêmica|Leitura confessional)/ });
  for (const radio of await outros.all()) {
    await radio.click();
    await expect(radio).toHaveAttribute("aria-checked", "true");
    await expect(doLivro18(page)).toHaveCount(0);
  }
  expect(new URL(page.url()).search).toBe("");
});

test("termo inexistente: nenhum resultado, o estado vazio com a dica e o botão de limpar", async ({
  page,
}) => {
  await entrar(page);
  await abrirBusca(page);
  await campo(page).fill("zzxqwvbn");
  await buscar(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Nenhum resultado para “zzxqwvbn”" }),
  ).toBeVisible();
  await expect(page.getByText("Nenhuma Fonte encontrada")).toBeVisible();
  await expect(resultados(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Limpar busca" }).click();
  await expect(campo(page)).toHaveValue("");
  await expect(page.getByText("Nenhuma Fonte encontrada")).toHaveCount(0);
  await expect(campo(page)).toBeFocused();
});

// Pedidos da Server Action da busca (POST com o cabeçalho `next-action`), vistos pelo corpo da requisição.
const ehAcao = (r: { method(): string; headers(): Record<string, string> }) =>
  r.method() === "POST" && r.headers()["next-action"] !== undefined;

test("trocar o Nível com a busca ainda sem resposta refaz a busca com o Nível novo", async ({
  page,
}) => {
  await entrar(page);
  await abrirBusca(page);
  const pedidos: string[] = [];
  let liberar: () => void = () => undefined;
  const segurada = new Promise<void>((r) => {
    liberar = r;
  });
  let primeira = true;
  await page.route("**/acervo/busca", async (rota) => {
    if (!ehAcao(rota.request())) return rota.continue();
    pedidos.push(rota.request().postData() ?? "");
    if (primeira) {
      primeira = false;
      await segurada;
    }
    return rota.continue();
  });
  await campo(page).fill("pilatos");
  await buscar(page).click();
  await expect.poll(() => pedidos.length).toBe(1);
  // Ainda sem resposta (visao nula): o Nível muda. O cliente de Server Actions do Next as enfileira, então o segundo
  // pedido só sai quando o primeiro responde; o que se exige é que ele saia, com o Nível novo, e que a resposta do
  // primeiro não fique na tela.
  await page
    .getByRole("radiogroup", { name: "Nível de fonte" })
    .getByRole("radio", { name: /^Fonte primária/ })
    .click();
  liberar();
  await expect.poll(() => pedidos.length).toBe(2);
  expect(pedidos[0]).not.toContain("primaria");
  expect(pedidos[1]).toContain("primaria");
  expect(pedidos[1]).toContain("pilatos");
  await expect(
    page.getByRole("status").filter({ hasText: /resultados? para “pilatos”/ }),
  ).toBeVisible();
  await expect(doLivro18(page).first()).toBeVisible();
  // Só duas buscas saíram: a resposta da primeira foi descartada, não refeita.
  expect(pedidos).toHaveLength(2);
});

test("sem conexão ao trocar o Nível, a resposta da busca em voo não aparece sob o filtro novo", async ({
  page,
}) => {
  await entrar(page);
  await abrirBusca(page);
  let liberar: () => void = () => undefined;
  const segurada = new Promise<void>((r) => {
    liberar = r;
  });
  await page.route("**/acervo/busca", async (rota) => {
    if (!ehAcao(rota.request())) return rota.continue();
    await segurada;
    return rota.continue();
  });
  await campo(page).fill("pilatos");
  await buscar(page).click();
  await page.evaluate(() =>
    Object.defineProperty(navigator, "onLine", { get: () => false, configurable: true }),
  );
  await page
    .getByRole("radiogroup", { name: "Nível de fonte" })
    .getByRole("radio", { name: /^Fonte primária/ })
    .click();
  await expect(page.getByText("Sem conexão. A busca precisa de internet.")).toBeVisible();
  liberar();
  await page.waitForTimeout(500);
  await expect(resultados(page)).toHaveCount(0);
});

test("Tentar de novo repete a tentativa que falhou, não a busca que está na tela", async ({
  page,
}) => {
  await entrar(page);
  await abrirBusca(page);
  const pedidos: string[] = [];
  let falhou = false;
  await page.route("**/acervo/busca", async (rota) => {
    if (!ehAcao(rota.request())) return rota.continue();
    const corpo = rota.request().postData() ?? "";
    pedidos.push(corpo);
    if (corpo.includes("tiago") && !falhou) {
      falhou = true;
      return rota.abort();
    }
    return rota.continue();
  });
  await campo(page).fill("pilatos");
  await buscar(page).click();
  await expect(doLivro18(page).first()).toBeVisible();
  await campo(page).fill("tiago");
  await buscar(page).click();
  await expect(page.getByText("Não conseguimos buscar agora. Tente de novo.")).toBeVisible();
  await page.getByRole("button", { name: "Tentar de novo" }).click();
  // O pedido repetido é o de "tiago" (não o de "pilatos", que é a busca que ficou na tela).
  await expect.poll(() => pedidos.length).toBe(3);
  expect(pedidos[2]).toContain("tiago");
  expect(pedidos[2]).not.toContain("pilatos");
  await expect(
    page.getByRole("status").filter({ hasText: /resultados? para “tiago”/ }),
  ).toBeVisible();
});

test.describe("mostrar mais resultados", () => {
  // Em série: a Fonte do lote é semeada uma vez por projeto e os dois testes a usam.
  test.describe.configure({ mode: "serial" });
  let sufixo = "";
  let palavra = "";

  // biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
  test.beforeAll(async ({}, info) => {
    sufixo = info.project.name;
    // Letras só, para o radical não depender de dígito; uma palavra por projeto (celular e computador rodam juntos).
    palavra = `abracadabrante${sufixo.replaceAll(/[^a-z]/g, "")}`;
    const slug = `fonte-busca-lote-${sufixo}`;
    await escrever(
      `insert into acervo.fonte (slug, titulo, nivel, tipo_texto, idioma, licenca, origem_nome, origem_url, publicada)
       values ($1, 'Fonte do lote de busca', 'primaria', 'integral', 'en', 'dp-anterior-1929', 'Origem de teste', 'https://exemplo.invalid/origem', true)`,
      [slug],
    );
    await escrever(
      `insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt)
       select $1 || '/lote-' || g, f.id, 'lote-' || g, g, 'Lote ' || g, 'Resumo do lote ' || g || ' com a palavra ' || $2
         from acervo.fonte f, generate_series(1, 25) g where f.slug = $1`,
      [slug, palavra],
    );
  });

  test.afterAll(async () => {
    const slug = `fonte-busca-lote-${sufixo}`;
    await escrever(
      "delete from acervo.fonte_secao where fonte_id in (select id from acervo.fonte where slug = $1)",
      [slug],
    );
    await escrever("delete from acervo.fonte where slug = $1", [slug]);
  });

  test("20 por vez, o restante em meta e o resto entra sem repetir", async ({ page }) => {
    await entrar(page);
    await abrirBusca(page);
    await campo(page).fill(palavra);
    await buscar(page).click();
    await expect(
      page.getByRole("status").filter({ hasText: `25 resultados para “${palavra}”` }),
    ).toBeVisible();
    await expect(resultados(page)).toHaveCount(20);
    await expect(page.getByText("Restam 5 resultados.")).toBeVisible();
    await page.getByRole("button", { name: "Mostrar mais resultados" }).click();
    await expect(resultados(page)).toHaveCount(25);
    await expect(page.getByRole("button", { name: "Mostrar mais resultados" })).toHaveCount(0);
    const hrefs = await resultados(page)
      .locator("h2 a")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(new Set(hrefs).size).toBe(25);
  });

  test("Tentar de novo depois de uma falha em Mostrar mais repete a página seguinte, não a primeira", async ({
    page,
  }) => {
    await entrar(page);
    await abrirBusca(page);
    const pedidos: string[] = [];
    let falhou = false;
    await page.route("**/acervo/busca", async (rota) => {
      if (!ehAcao(rota.request())) return rota.continue();
      const corpo = rota.request().postData() ?? "";
      pedidos.push(corpo);
      if (corpo.includes("deslocamento") && !falhou) {
        falhou = true;
        return rota.abort();
      }
      return rota.continue();
    });
    await campo(page).fill(palavra);
    await buscar(page).click();
    await expect(resultados(page)).toHaveCount(20);
    await page.getByRole("button", { name: "Mostrar mais resultados" }).click();
    await expect(page.getByText("Não conseguimos buscar agora. Tente de novo.")).toBeVisible();
    await page.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(resultados(page)).toHaveCount(25);
    // Os três pedidos: a primeira página, a segunda (que falhou) e a segunda de novo, com o mesmo deslocamento.
    expect(pedidos).toHaveLength(3);
    expect(pedidos[1]).toContain("deslocamento");
    expect(pedidos[2]).toContain("deslocamento");
  });
});
