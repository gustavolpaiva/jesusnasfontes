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

const NAO_PODE_APARECER =
  /hydrat|validateDOMNesting|cannot be a descendant|cannot contain|did not match/i;

/** Avisos de hidratação e de elemento inválido dentro de `<p>`: o console tem de ficar sem nenhum. */
function vigiarConsole(page: Page): string[] {
  const avisos: string[] = [];
  page.on("console", (m) => {
    if (NAO_PODE_APARECER.test(m.text())) avisos.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (NAO_PODE_APARECER.test(e.message)) avisos.push(e.message);
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
