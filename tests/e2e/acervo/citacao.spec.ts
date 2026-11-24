import { expect, type Page, test } from "@playwright/test";
import {
  JOSEFO,
  PAPEIS,
  removerCitacoes,
  type SemeadoDeCitacao,
  semearCitacoes,
  tentarAprovar,
} from "../../support/citacao-e2e";
import { esperarEstudoAssentado, usarVozImediata } from "../../support/estudo-assentado";
import { esperarHidratado } from "../../support/hidratacao";
import { convidarParaTeste, emailDeTeste, entrarPorLink, lerTexto } from "../../support/login-e2e";

// A Citação no Estudo (ACER-06, ACER-10, D-10, D-11, D-12, D-16; UI-SPEC tela 8), de ponta a ponta. As Citações são
// SINTÉTICAS e a aprovação nasce pela função real do banco (`acervo.aprovar_afirmacao`), com uma sessão de Admin de teste:
// nenhuma Citação ou Grau real é aprovado por teste. Cada projeto (celular e computador) usa o SEU Estudo da Base
// histórica e as suas fichas, porque os dois rodam este arquivo ao mesmo tempo no mesmo banco.
test.skip(
  !!process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo real: rode sem E2E_CONTEUDO_DIR",
);

test.describe.configure({ mode: "default" });

let semeado: SemeadoDeCitacao;
let projeto = "";

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  projeto = info.project.name;
  semeado = await semearCitacoes(projeto);
});

test.afterAll(async () => {
  if (semeado) await removerCitacoes(semeado);
});

// Ruído preexistente do Caderno (`textarea` com `caret-color` posto antes de hidratar), fora do escopo da Citação.
const RUIDO_DO_CADERNO = /anotacao-campo/;
const NAO_PODE_APARECER =
  /hydrat|validateDOMNesting|cannot be a descendant|cannot contain|did not match/i;

/** Avisos de hidratação e de elemento inválido dentro de `<p>`: o console tem de ficar sem nenhum. */
function vigiarConsole(page: Page): string[] {
  const avisos: string[] = [];
  page.on("console", (m) => {
    if (NAO_PODE_APARECER.test(m.text()) && !RUIDO_DO_CADERNO.test(m.text())) avisos.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (NAO_PODE_APARECER.test(e.message) && !RUIDO_DO_CADERNO.test(e.message))
      avisos.push(e.message);
  });
  return avisos;
}

async function abrirEstudo(page: Page): Promise<void> {
  await usarVozImediata(page);
  const email = emailDeTeste("citacao");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  await page.goto(`/estudos/${semeado.estudo}`);
  await esperarEstudoAssentado(page);
}

const citacaoDe = (page: Page, afirmacao: string) =>
  page.locator(`[data-slot="citacao"][data-citacao-de="${afirmacao}"]`);
const botaoDe = (page: Page, afirmacao: string) =>
  citacaoDe(page, afirmacao).locator('[data-slot="citacao-botao"]');
const painelDe = (page: Page, afirmacao: string) =>
  citacaoDe(page, afirmacao).locator('[data-slot="citacao-painel"]');

test("Citação de Passagem: o botão com o par de selos no lugar do chip, de 44 px, e o painel abre ali mesmo, sem link (D-10, D-16)", async ({
  page,
}) => {
  const console_ = vigiarConsole(page);
  await abrirEstudo(page);
  const a = semeado.afirmacoes.passagem;

  const botao = botaoDe(page, a);
  await expect(botao).toBeVisible();
  // O par: Nível primeiro, Grau depois; a Passagem é "Fonte primária" por tipo de alvo.
  await expect(botao.locator('[data-slot="selo-nivel"]')).toHaveText("Fonte primária");
  await expect(botao.locator('[data-slot="selo-grau"]')).toHaveText("Consenso");
  await expect(botao.locator('[data-slot="selo-grau"] [data-ponto="cheio"]')).toHaveCount(3);
  // Os pontos são decoração: escondidos do leitor de tela.
  await expect(botao.locator('[data-slot="pontos-do-grau"]')).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  // Nome acessível pelo conteúdo (o bloco tem duas Afirmações: "Afirmação 1").
  await expect(botao).toHaveAccessibleName(
    /Fonte primária\s*,\s*Grau de certeza:\s*Consenso\s*,\s*Afirmação\s*1\s*\.\s*Mostrar a Citação\./,
  );
  await expect(botao).toHaveAttribute("aria-expanded", "false");
  await expect(botao).toHaveAttribute("aria-controls", /.+/);
  const caixa = await botao.boundingBox();
  expect(caixa?.height ?? 0).toBeGreaterThanOrEqual(44);

  // O chip tracejado dessa Afirmação NÃO existe: o botão ocupa o lugar dele.
  await expect(page.locator(`[data-slot="chip-fonte"]`)).toHaveCount(2); // irmã e ficha em rascunho

  await esperarHidratado(botao);
  await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await expect(botao).toHaveAccessibleName(/Esconder a Citação\./);

  const painel = painelDe(page, a);
  await expect(painel).toBeVisible();
  await expect(painel.locator('[data-slot="citacao-fonte"]')).toHaveText("Bíblia Livre, Lucas 2:7");
  const versiculo = await lerTexto(
    "select conteudo as t from acervo.texto_versiculo where versiculo_id = 42002007 and texto_id = 'blivre-n4'",
  );
  expect(versiculo.length).toBeGreaterThan(10);
  await expect(painel.locator('[data-slot="trecho-citado"]')).toContainText(
    versiculo.trim().slice(0, 40),
  );
  await expect(painel.locator('[data-slot="trecho-citado"]')).toHaveAttribute("lang", "pt-BR");
  await expect(painel).toContainText("Texto em português, Bíblia Livre (n4).");
  await expect(painel).toContainText(
    "Grau de certeza: Consenso. Quase todos os pesquisadores aceitam, crentes ou não.",
  );
  // Passagem não tem página própria ainda: nenhum link no painel.
  await expect(painel.locator("a")).toHaveCount(0);
  // O foco não vai para o painel (o teste de teclado prova que ele FICA no botão; o WebKit não foca botão no clique).
  await expect(painel.locator(":focus")).toHaveCount(0);

  // Segunda abertura-fechamento: fecha e o painel some.
  await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "false");
  await expect(painel).toHaveCount(0);

  expect(console_, "avisos de hidratação ou de elemento inválido").toEqual([]);
});

test("teclado: Enter e Espaço abrem e fecham; o foco continua no botão", async ({ page }) => {
  const console_ = vigiarConsole(page);
  await abrirEstudo(page);
  const botao = botaoDe(page, semeado.afirmacoes.passagem);
  await esperarHidratado(botao);
  await botao.focus();
  await page.keyboard.press("Enter");
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await expect(botao).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(botao).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Space");
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await expect(botao).toBeFocused();
  await page.keyboard.press("Space");
  await expect(botao).toHaveAttribute("aria-expanded", "false");
  expect(console_).toEqual([]);
});

test("a Afirmação irmã e a ficha em rascunho continuam com 'Fonte em preparação'; o ordinal acompanha o par (D-12)", async ({
  page,
}) => {
  await abrirEstudo(page);
  const chips = page.locator('[data-slot="chip-fonte"]');
  await expect(chips).toHaveCount(2);
  for (const chip of await chips.all()) {
    await expect(chip).toHaveCSS("border-top-style", "dashed");
    await expect(chip).toContainText("Fonte em preparação");
    expect(await chip.getAttribute("role")).toBeNull();
  }
  // A irmã do bloco (2ª Afirmação) mostra "· 2"; a da Passagem mostra o botão com "· 1".
  await expect(chips.first()).toHaveText("Fonte em preparação · 2");
  const marca = botaoDe(page, semeado.afirmacoes.passagem).locator("span.text-meta");
  await expect(marca).toContainText("1");
  await expect(marca.locator('[aria-hidden="true"]')).toHaveText("·");
  // O banco recusa aprovar a Citação de uma ficha em rascunho: nada foi aprovado, nenhum botão existe para ela.
  expect(await tentarAprovar(semeado.afirmacoes["ficha-rascunho"], "consenso")).toBe("P0003");
  await expect(citacaoDe(page, semeado.afirmacoes["ficha-rascunho"])).toHaveCount(0);
  expect(PAPEIS).toContain("ficha-rascunho");
});

test("o resumo dos dois selos aparece uma vez por Estudo, antes da primeira seção com Citação, e o de 'Fonte em preparação' continua (UI-SPEC tela 8)", async ({
  page,
}) => {
  await abrirEstudo(page);
  await expect(page.locator('[data-slot="resumo-citacao"]')).toHaveCount(1);
  await expect(page.locator('[data-slot="resumo-fonte"]')).toHaveCount(1);
  await expect(page.locator('[data-slot="resumo-citacao"]')).toContainText(
    "O que são os dois selos?",
  );
  expect(JOSEFO.rotulo).toContain("Josefo");
});

/** Abre a Citação da Afirmação e devolve o painel. */
async function abrir(page: Page, afirmacao: string) {
  const botao = botaoDe(page, afirmacao);
  await esperarHidratado(botao);
  await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  const painel = painelDe(page, afirmacao);
  await expect(painel).toBeVisible();
  return { botao, painel };
}

/** O painel só pode ter `span`, `q`, `a`, `em`, `sup`, `time` e o ícone: nunca `p`, `div`, `blockquote`, `ul` (HTML válido dentro de `<p>`). */
async function semElementoInvalido(painel: ReturnType<typeof painelDe>): Promise<void> {
  const proibidos = await painel.evaluate(
    (el) =>
      el.querySelectorAll("p, div, blockquote, ul, ol, li, h1, h2, h3, h4, img, script").length,
  );
  expect(
    proibidos,
    "elementos que não cabem dentro de um <p> ou que o trecho de terceiros injetou",
  ).toBe(0);
}

test("Citação de parágrafo de Fonte: nome da Fonte e referência, trecho em inglês com lang, link de 44 px para o parágrafo (D-10)", async ({
  page,
}) => {
  const console_ = vigiarConsole(page);
  await abrirEstudo(page);
  const { botao, painel } = await abrir(page, semeado.afirmacoes.paragrafo);

  await expect(botao.locator('[data-slot="selo-grau"]')).toHaveText("Posição majoritária");
  await expect(botao.locator('[data-slot="selo-grau"] [data-ponto="cheio"]')).toHaveCount(2);
  await expect(botao.locator('[data-slot="selo-grau"] [data-ponto="vazado"]')).toHaveCount(1);

  await expect(painel.locator('[data-slot="citacao-fonte"]')).toHaveText(
    JOSEFO.rotulo.replace(", Antiguidades", ", Antiguidades"),
  );
  // Só o título da obra em itálico.
  await expect(painel.locator('[data-slot="citacao-fonte"] em')).toHaveText(
    "Antiguidades Judaicas",
  );
  const trecho = painel.locator('[data-slot="trecho-citado"]');
  await expect(trecho).toHaveAttribute("lang", "en");
  // A marcação do trecho é TEXTO: o `<img>` aparece escrito, não como elemento, e nada executou.
  await expect(trecho).toContainText(JOSEFO.trecho);
  expect(
    await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
  ).toBeUndefined();
  await expect(painel).toContainText("Trecho em inglês, como está no Acervo.");
  await expect(painel).toContainText(
    "Grau de certeza: Posição majoritária. A maior parte dos pesquisadores aceita; uma minoria discorda.",
  );

  const link = painel.getByRole("link", { name: "Ler na Fonte: Antiguidades Judaicas 18.63" });
  await expect(link).toHaveAttribute("href", `/acervo/${JOSEFO.slug}/${JOSEFO.secao}#p-18.63`);
  expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await semElementoInvalido(painel);
  expect(console_).toEqual([]);
});

test("Citação de ficha: 'Trecho da ficha, p. X de Obra', 'Verificada em' sem nome, nunca 'leia o livro' (D-11, D-05)", async ({
  page,
}) => {
  const console_ = vigiarConsole(page);
  await abrirEstudo(page);
  const { botao, painel } = await abrir(page, semeado.afirmacoes.ficha);

  await expect(botao.locator('[data-slot="selo-nivel"]')).toHaveText("Pesquisa acadêmica");
  await expect(botao.locator('[data-slot="selo-grau"]')).toHaveText("Disputada");
  await expect(botao.locator('[data-slot="selo-grau"] [data-ponto="cheio"]')).toHaveCount(1);
  await expect(botao.locator('[data-slot="selo-grau"] [data-ponto="vazado"]')).toHaveCount(2);

  // A frase é LITERAL, nesta forma; a obra em itálico.
  await expect(painel.locator('[data-slot="citacao-fonte"]')).toHaveText(
    "Trecho da ficha, p. 39–53 de Obra de Teste Completa",
  );
  await expect(painel.locator('[data-slot="citacao-fonte"] em')).toHaveText(
    "Obra de Teste Completa",
  );
  // Sem trecho original curto, o texto em português da ficha.
  const trecho = painel.locator('[data-slot="trecho-citado"]');
  await expect(trecho).toContainText("Primeiro argumento da obra de teste");
  await expect(trecho).toHaveAttribute("lang", "pt-BR");
  await expect(painel).toContainText(/Verificada em \d{1,2} de \p{L}+ de \d{4}\./u);
  await expect(painel).toContainText(
    "Grau de certeza: Disputada. Pesquisadores sérios divergem e não há posição majoritária clara.",
  );
  const texto = (await painel.innerText()).toLowerCase();
  expect(texto).not.toContain("leia o livro");
  expect(texto).not.toContain("@");
  const link = painel.getByRole("link", { name: "Ver a ficha de Obra de Teste Completa" });
  await expect(link).toHaveAttribute("href", `/acervo/${semeado.fichas.completa}`);
  expect((await link.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await semElementoInvalido(painel);
  expect(console_).toEqual([]);
});

test("várias Citações: o botão mostra o Nível mais direto; o painel é a lista 'Citações (3)' com um selo de Nível por Citação", async ({
  page,
}) => {
  const console_ = vigiarConsole(page);
  await abrirEstudo(page);
  const { botao, painel } = await abrir(page, semeado.afirmacoes.varias);

  // As três Citações: Passagem (primária), parágrafo (primária) e ficha (acadêmica): o botão mostra Fonte primária.
  await expect(botao.locator('[data-slot="selo-nivel"]')).toHaveText("Fonte primária");
  await expect(botao.locator('[data-slot="selo-grau"]')).toHaveText("Consenso");
  await expect(painel).toContainText("Citações (3)");
  const lista = painel.locator('[role="list"]');
  await expect(lista).toHaveCount(1);
  const itens = lista.locator('[role="listitem"]');
  await expect(itens).toHaveCount(3);
  await expect(itens.nth(0)).toContainText("Citação 1 de 3");
  await expect(itens.nth(2)).toContainText("Citação 3 de 3");
  await expect(itens.nth(0).locator('[data-slot="selo-nivel"]')).toHaveText("Fonte primária");
  await expect(itens.nth(2).locator('[data-slot="selo-nivel"]')).toHaveText("Pesquisa acadêmica");
  await expect(itens.nth(0).locator('[data-alvo="passagem"]')).toHaveCount(1);
  await expect(itens.nth(1).locator('[data-alvo="paragrafo"]')).toHaveCount(1);
  await expect(itens.nth(2).locator('[data-alvo="ficha"]')).toHaveCount(1);
  await semElementoInvalido(painel);
  expect(console_).toEqual([]);
});

test("trecho indisponível: o aviso do contrato aparece, o nome da Fonte e o link ficam, e o Estudo não cai", async ({
  page,
}) => {
  const console_ = vigiarConsole(page);
  await abrirEstudo(page);
  const { painel } = await abrir(page, semeado.afirmacoes.indisponivel);
  const aviso = painel.locator('[data-slot="aviso-do-trecho"]');
  await expect(aviso).toHaveText("Atenção. Não foi possível mostrar o trecho agora.");
  await expect(aviso).toHaveAttribute("role", "status");
  await expect(painel.locator('[data-slot="citacao-fonte"]')).toHaveText(JOSEFO.rotulo);
  await expect(painel.getByRole("link", { name: /Ler na Fonte/ })).toBeVisible();
  await expect(painel.locator('[data-slot="trecho-citado"]')).toHaveCount(0);
  // O resto do Estudo está de pé.
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await semElementoInvalido(painel);
  expect(console_).toEqual([]);
});

test("a ficha NÃO verificada nunca sustenta Citação: o banco recusa (P0003) e a Afirmação continua com 'Fonte em preparação'", async ({
  page,
}) => {
  await abrirEstudo(page);
  const a = semeado.afirmacoes["ficha-rascunho"];
  expect(await tentarAprovar(a, "consenso")).toBe("P0003");
  await page.reload();
  await esperarEstudoAssentado(page);
  await expect(citacaoDe(page, a)).toHaveCount(0);
  await expect(page.locator('[data-slot="chip-fonte"]')).toHaveCount(2);
});

test("vários painéis podem ficar abertos ao mesmo tempo, sem fechar o outro", async ({ page }) => {
  await abrirEstudo(page);
  const um = await abrir(page, semeado.afirmacoes.passagem);
  const dois = await abrir(page, semeado.afirmacoes.paragrafo);
  await expect(um.painel).toBeVisible();
  await expect(dois.painel).toBeVisible();
  await expect(um.botao).toHaveAttribute("aria-expanded", "true");
});

// Reflow (UI-SPEC "Verificação renderizada", critério l): o Estudo com o par de selos e TODOS os painéis abertos não
// rola na horizontal em 390 nem em 320 px, no tamanho de texto padrão e no passo 5, medido antes e depois de abrir.
for (const largura of [390, 320]) {
  for (const passo of ["3", "5"]) {
    test(`sem rolagem horizontal em ${largura} px, passo ${passo} do texto, antes e depois de abrir os painéis`, async ({
      page,
      context,
      baseURL,
    }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: largura, height: 800 });
      await context.addCookies([
        { name: "escala-texto", value: passo, url: baseURL ?? "http://localhost" },
      ]);
      const console_ = vigiarConsole(page);
      await abrirEstudo(page);
      const sobra = () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
      expect(await sobra(), "antes de abrir").toBeLessThanOrEqual(0);
      const botoes = page.locator('[data-slot="citacao-botao"]');
      const n = await botoes.count();
      expect(n).toBeGreaterThanOrEqual(5);
      for (let i = 0; i < n; i++) {
        await esperarHidratado(botoes.nth(i));
        await botoes.nth(i).click();
      }
      await expect(page.locator('[data-slot="citacao-painel"]')).toHaveCount(n);
      expect(await sobra(), "depois de abrir os painéis").toBeLessThanOrEqual(0);
      // Nenhum painel passa da largura da janela nem tem filho que passe.
      const excesso = await page.evaluate(() => {
        const janela = document.documentElement.clientWidth;
        return [
          ...document.querySelectorAll(
            '[data-slot="citacao-painel"], [data-slot="citacao-painel"] *',
          ),
        ]
          .filter((el) => el.getBoundingClientRect().right > janela + 1)
          .map((el) => el.tagName);
      });
      expect(excesso, "elemento do painel fora da janela").toEqual([]);
      expect(console_).toEqual([]);
    });
  }
}
