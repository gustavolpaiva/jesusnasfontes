import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import {
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
} from "../../support/login-e2e";

// Caderno (ANOT-03): lista de Anotações e de Anotações de Sessão, 20 por vez, e busca por palavra por POST.
// Roda sobre o conteúdo mínimo (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

async function entrar(page: Page, prefixo = "cad"): Promise<{ email: string; id: string }> {
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return { email, id: await idDoUsuario(email) };
}

const campoDoEstudo = (page: Page) => page.getByRole("textbox", { name: "Minha anotação" });
const entradas = (page: Page) => page.locator('[data-slot="entrada-caderno"]');
const busca = (page: Page) => page.getByRole("searchbox", { name: "Buscar nas Anotações" });

async function escreverNoEstudo(page: Page, slug: string, texto: string): Promise<void> {
  await page.goto(`/estudos/${slug}`);
  await esperarHidratado(campoDoEstudo(page));
  await campoDoEstudo(page).fill(texto);
  await expect(page.locator('[data-slot="save-status"]')).toHaveText("Salvo");
}

async function abrirCaderno(page: Page): Promise<void> {
  await page.goto("/caderno");
  await expect(page.getByRole("heading", { level: 1, name: "Caderno" })).toBeVisible();
  await esperarHidratado(page.getByRole("button", { name: "Buscar", exact: true }));
}

async function buscar(page: Page, termo: string): Promise<void> {
  await busca(page).fill(termo);
  await page.getByRole("button", { name: "Buscar", exact: true }).click();
}

// Sessões encerradas com Anotação, semeadas direto no banco da execução (o fluxo da Sessão tem teste próprio).
async function semearSessoes(id: string, quantas: number, prefixo: string): Promise<void> {
  await escrever(
    `insert into privado.sessao (estudante_id, check_in_em, check_out_em, estudo_inicio_id, estudo_fim_id, anotacao)
     select $1, now() - (g || ' hours')::interval - interval '20 minutes', now() - (g || ' hours')::interval,
            (select id from conteudo.estudo where slug = 'o-nascimento'),
            (select id from conteudo.estudo where slug = 'batismo-e-tentacao'),
            $3 || ' ' || g
     from generate_series(1, $2::int) g`,
    [id, String(quantas), prefixo],
  );
}

test("sem Anotações: o estado vazio do contrato e a ação para as Trilhas", async ({ page }) => {
  await entrar(page);
  await abrirCaderno(page);
  await expect(page.getByText("Todas as suas Anotações, num só lugar.")).toBeVisible();
  await expect(page.getByText("Seu Caderno está vazio")).toBeVisible();
  await expect(
    page.getByText("Quando você escrever uma Anotação em um Estudo, ela aparece aqui."),
  ).toBeVisible();
  await expect(
    page.getByText("Procure por uma palavra. A busca ignora acentos e maiúsculas."),
  ).toBeVisible();
  await expect(entradas(page)).toHaveCount(0);
  await page.getByRole("link", { name: "Ir para as Trilhas" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
});

test("a lista reúne Anotações de dois Estudos e uma Anotação de Sessão, a mais recente primeiro", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await escreverNoEstudo(page, "o-nascimento", "Primeira Anotação.");
  await escreverNoEstudo(page, "batismo-e-tentacao", "Segunda Anotação.");
  await semearSessoes(id, 1, "Terminei a Sessão com gratidão");
  await abrirCaderno(page);

  await expect(entradas(page)).toHaveCount(3);
  // A Anotação traz a data e o título do Estudo como link; a da Sessão traz o intervalo, sem link.
  const dasAnotacoes = page.locator('[data-slot="entrada-caderno"][data-tipo="anotacao"]');
  await expect(dasAnotacoes).toHaveCount(2);
  await expect(dasAnotacoes.first().getByText(/^atualizada em \d{2}\/\d{2}$/)).toBeVisible();
  await expect(
    dasAnotacoes.first().getByRole("link", { name: "Batismo e tentação" }),
  ).toHaveAttribute("href", "/estudos/batismo-e-tentacao");
  const daSessao = page.locator('[data-slot="entrada-caderno"][data-tipo="sessao"]');
  await expect(daSessao).toHaveCount(1);
  await expect(
    daSessao.getByText(/^Anotação da Sessão · \d{2}\/\d{2}, \d{2}:\d{2} a \d{2}:\d{2}$/),
  ).toBeVisible();
  await expect(daSessao.getByText("de O nascimento até Batismo e tentação")).toBeVisible();
  await expect(daSessao.getByRole("link")).toHaveCount(0);
  await expect(daSessao.getByText("Terminei a Sessão com gratidão 1")).toBeVisible();
  // A Anotação mais recente vem antes da anterior.
  const titulos = await dasAnotacoes.getByRole("heading").allTextContents();
  expect(titulos).toEqual(["Batismo e tentação", "O nascimento"]);
  // O link leva ao Estudo.
  await dasAnotacoes.first().getByRole("link").click();
  await expect(page).toHaveURL(/\/estudos\/batismo-e-tentacao$/);
});

test("a busca ignora acento e maiúscula, marca a palavra sem depender de cor e não põe o termo na URL", async ({
  page,
}) => {
  await entrar(page);
  await escreverNoEstudo(page, "o-nascimento", "Pensei no perdão que Jesus oferece ao pecador.");
  await escreverNoEstudo(page, "batismo-e-tentacao", "Uma anotação sobre outra coisa, o deserto.");
  await abrirCaderno(page);
  const antes = page.url();

  await buscar(page, "perdao");
  await expect(page.getByText('1 Anotação com "perdao"')).toBeVisible();
  await expect(entradas(page)).toHaveCount(1);
  expect(page.url()).toBe(antes);
  expect(new URL(page.url()).search).toBe("");

  // A palavra achada é um <mark> sem fundo, em peso 600 e sublinhada: visível em escala de cinza.
  const marca = entradas(page).locator("mark");
  await expect(marca).toHaveText("perdão");
  const estilo = await marca.evaluate((el) => {
    const c = getComputedStyle(el);
    return {
      peso: c.fontWeight,
      linha: c.textDecorationLine,
      espessura: c.textDecorationThickness,
      fundo: c.backgroundColor,
    };
  });
  expect(estilo.peso).toBe("600");
  expect(estilo.linha).toContain("underline");
  expect(estilo.espessura).toBe("2px");
  expect(estilo.fundo).toBe("rgba(0, 0, 0, 0)");
  // O texto do resto não vira HTML: segue como texto.
  await expect(entradas(page).getByText(/Pensei no/)).toBeVisible();

  // Maiúscula e acento no termo; palavra que não existe; "Limpar busca" volta à lista toda.
  await buscar(page, "PERDÃO");
  await expect(page.getByText('1 Anotação com "PERDÃO"')).toBeVisible();
  await buscar(page, "inexistente");
  await expect(page.getByText('Nenhuma Anotação com "inexistente"')).toBeVisible();
  await expect(page.getByText("Nenhuma Anotação encontrada")).toBeVisible();
  await expect(
    page.getByText("Tente outra palavra ou uma parte dela. A busca ignora acentos e maiúsculas."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Limpar busca" }).click();
  await expect(entradas(page)).toHaveCount(2);
  await expect(busca(page)).toHaveValue("");
  expect(page.url()).toBe(antes);
});

test("a busca acha também a Anotação de Sessão e conta no plural", async ({ page }) => {
  const { id } = await entrar(page);
  await escreverNoEstudo(page, "o-nascimento", "A luz da manhã no deserto.");
  await semearSessoes(id, 2, "Sessão da luz");
  await abrirCaderno(page);
  await buscar(page, "luz");
  await expect(page.getByText('3 Anotações com "luz"')).toBeVisible();
  await expect(entradas(page)).toHaveCount(3);
  await expect(page.locator('[data-tipo="sessao"]')).toHaveCount(2);
});

test("20 por vez: 'Mostrar mais Anotações' traz o resto, com o total que falta", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await escreverNoEstudo(page, "o-nascimento", "Uma Anotação de Estudo.");
  await semearSessoes(id, 24, "Sessão numerada");
  await abrirCaderno(page);
  await expect(entradas(page)).toHaveCount(20);
  await expect(page.getByText("Restam 5 entradas.")).toBeVisible();
  await page.getByRole("button", { name: "Mostrar mais Anotações" }).click();
  await expect(entradas(page)).toHaveCount(25);
  await expect(page.getByRole("button", { name: "Mostrar mais Anotações" })).toHaveCount(0);
  // Nenhuma entrada repetida.
  const chaves = await entradas(page).evaluateAll((els) => els.map((e) => e.textContent));
  expect(new Set(chaves).size).toBe(25);
});

test("o trecho de uma Anotação longa ocupa no máximo 3 linhas e o campo do Estudo cresce com o texto", async ({
  page,
}) => {
  await entrar(page);
  const longo = Array.from({ length: 60 }, (_, i) => `linha ${i} da anotação longa`).join("\n");
  await escreverNoEstudo(page, "o-nascimento", longo);
  const alturaCurta = await campoDoEstudo(page).evaluate((el) => el.getBoundingClientRect().height);
  expect(alturaCurta).toBeGreaterThan(400);
  await abrirCaderno(page);
  const trecho = entradas(page).locator("p.line-clamp-3");
  const medidas = await trecho.evaluate((el) => {
    const c = getComputedStyle(el);
    return { altura: el.getBoundingClientRect().height, linha: Number.parseFloat(c.lineHeight) };
  });
  expect(medidas.altura).toBeLessThanOrEqual(medidas.linha * 3 + 1);
});

test("sem conexão a busca diz que precisa de internet e a lista continua", async ({
  page,
  context,
}) => {
  await entrar(page);
  await escreverNoEstudo(page, "o-nascimento", "Algo para achar depois.");
  await abrirCaderno(page);
  await context.setOffline(true);
  await buscar(page, "algo");
  await expect(page.getByText("Sem conexão. A busca precisa de internet.")).toBeVisible();
  await expect(entradas(page)).toHaveCount(1);
  await context.setOffline(false);
  await buscar(page, "algo");
  await expect(page.getByText('1 Anotação com "algo"')).toBeVisible();
  await expect(page.getByText("Sem conexão. A busca precisa de internet.")).toHaveCount(0);
});

test("a busca de uma conta não acha o texto de outra", async ({ page, browser }) => {
  await entrar(page, "cada");
  const palavra = `exclusiva${randomUUID().slice(0, 8)}`;
  await escreverNoEstudo(page, "o-nascimento", `Texto só meu com ${palavra}.`);
  await abrirCaderno(page);
  await buscar(page, palavra);
  await expect(page.getByText(`1 Anotação com "${palavra}"`)).toBeVisible();

  const outra = await browser.newContext();
  const aba = await outra.newPage();
  await entrar(aba, "vizinha");
  await abrirCaderno(aba);
  await expect(aba.getByText("Seu Caderno está vazio")).toBeVisible();
  await buscar(aba, palavra);
  await expect(aba.getByText(`Nenhuma Anotação com "${palavra}"`)).toBeVisible();
  await expect(aba.getByText(palavra, { exact: false }).first()).toBeVisible(); // só no texto da contagem
  await expect(entradas(aba)).toHaveCount(0);
  await outra.close();
});

test("a página do Caderno e do Estudo não vão para cache e o Caderno passa pelo axe", async ({
  page,
}) => {
  await entrar(page);
  await escreverNoEstudo(page, "o-nascimento", "Para o axe ver.");
  const resposta = await page.goto("/caderno");
  expect(resposta?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { level: 1, name: "Caderno" })).toBeVisible();
  const estudo = await page.goto("/estudos/o-nascimento");
  expect(estudo?.headers()["cache-control"]).toContain("no-store");
  await page.goto("/caderno");
  await esperarHidratado(page.getByRole("button", { name: "Buscar", exact: true }));
  const resultado = await new AxeBuilder({ page }).analyze();
  expect(resultado.violations.map((v) => v.id)).toEqual([]);
  await buscar(page, "axe");
  await expect(page.getByText('1 Anotação com "axe"')).toBeVisible();
  const comBusca = await new AxeBuilder({ page }).analyze();
  expect(comBusca.violations.map((v) => v.id)).toEqual([]);
});

test("limpar a busca antes de a resposta de outra busca chegar: a resposta atrasada não traz a busca de volta (revisão, rodada 10)", async ({
  page,
}) => {
  const { id } = await entrar(page, "limpa");
  // Só letras: o termo é uma palavra para a busca (números e hífens a dividiriam).
  const sufixo = randomUUID()
    .replace(/[^a-f]/g, "")
    .slice(0, 8);
  const um = `palavraum${sufixo}`;
  const dois = `palavradois${sufixo}`;
  await semearSessoes(id, 2, um);
  await semearSessoes(id, 1, dois);
  await abrirCaderno(page);
  await expect(entradas(page)).toHaveCount(3);
  await buscar(page, um);
  await expect(entradas(page)).toHaveCount(2);

  // A busca seguinte fica segura a caminho; a pessoa limpa a busca antes de a resposta chegar.
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  let respondido = () => {};
  const chegou = new Promise<void>((r) => {
    respondido = r;
  });
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes(dois)) {
      await portao;
      await rota.fulfill({ response: await rota.fetch() });
      respondido();
      return;
    }
    await rota.continue();
  });
  await buscar(page, dois);
  await page.getByRole("button", { name: "Limpar busca" }).click();
  await expect(busca(page)).toHaveValue("");
  await expect(entradas(page)).toHaveCount(3);
  liberar();
  await chegou;
  await page.waitForTimeout(800);
  // A lista inteira continua; a busca limpa não voltou.
  await expect(entradas(page)).toHaveCount(3);
  await expect(busca(page)).toHaveValue("");
  await expect(page.getByRole("button", { name: "Limpar busca" })).toHaveCount(0);
});
