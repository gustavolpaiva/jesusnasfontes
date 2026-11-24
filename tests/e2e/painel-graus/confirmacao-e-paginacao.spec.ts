import { expect as esperar, test } from "@playwright/test";
import { removerLoteDePropostas, semearLoteDePropostas } from "../../support/citacao-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";

// Os dois consertos da revisão do plano 02-21, de ponta a ponta:
//   1. aprovar a ÚLTIMA proposta pendente esvazia "Pendentes" na revalidação: a mensagem de sucesso e o destino de foco
//      moram na ListaGraus, e o estado vazio é renderizado POR ELA — a confirmação continua montada e focada;
//   2. além do teto antigo de 400, o endereço que "Mostrar mais" gera (ate=420) continua valendo 420: a lista nunca
//      encolhe de volta para 20 em silêncio.
// Como o teste de "estado vazio" do spec principal, estes dois precisam de um banco SEM propostas de outros testes: o
// primeiro precisa que a lista fique vazia de verdade, e o lote do segundo disputa as Afirmações livres com o spec
// principal. Roda sozinho:
//   E2E_GRAUS_VAZIO=1 pnpm test:e2e tests/e2e/painel-graus
test.skip(
  !!process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo real: rode sem E2E_CONTEUDO_DIR",
);
test.skip(
  process.env.E2E_GRAUS_VAZIO !== "1",
  "só num banco sem propostas de outros testes (veja o comentário)",
);

test.describe.configure({ mode: "default", timeout: 120_000 });
// `expect.configure` DEVOLVE um `expect` novo (não muda o global): sob a carga de vários processos o padrão de 5 s dá falso vermelho.
const expect = esperar.configure({ timeout: 30000 });

let projeto = "";

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  projeto = info.project.name;
});

const LISTA = "/admin/acervo/graus";

test("última pendente: aprovar esvazia a lista SEM perder a mensagem de sucesso e o foco nela", async ({
  page,
}) => {
  test.skip(projeto !== "celular", "o lote é semeado uma vez, por um projeto só");
  // Uma proposta pendente, e nenhuma outra no banco: aprová-la esvazia "Pendentes".
  const lote = await semearLoteDePropostas(1);
  try {
    await entrarComoAdmin(page, `graus-ultima-${projeto}`);
    await page.goto(LISTA);
    await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();
    const item = page.locator(`[data-slot="accordion-item"][data-afirmacao="${lote[0]}"]`);
    const gatilho = item.locator('[data-slot="proposta-gatilho"]');
    await esperarHidratado(gatilho);
    await gatilho.click();
    const aprovar = item.locator('[data-slot="aprovar-grau"]');
    await expect(aprovar).toBeVisible();
    await aprovar.click();

    // PRIMEIRO a revalidação precisa ter chegado: a lista ficou vazia com o estado vazio do contrato. Só DEPOIS se pode
    // afirmar que a confirmação sobreviveu a ela — checar a mensagem antes seria vencer a corrida contra a montagem
    // nova e passar até no código antigo (o aviso sumia junto com a lista um instante depois).
    await expect(
      page.getByRole("heading", { level: 2, name: "Nenhuma proposta pendente" }),
    ).toBeVisible();
    await expect(
      page.getByText("As propostas aparecem aqui quando o arquivo de graus for carregado."),
    ).toBeVisible();
    await expect(page.locator('[data-slot="accordion-item"]')).toHaveCount(0);

    // Agora, com a lista vazia: a confirmação (região de status e destino de foco) continua MONTADA e focada — antes
    // do conserto, a página trocava a lista pelo estado vazio e a mensagem sumia junto.
    const aviso = page.locator('[data-slot="aviso-dos-graus"]');
    await expect(aviso.getByRole("status")).toContainText("Grau aprovado: Consenso.");
    await expect(aviso).toBeFocused();
  } finally {
    await removerLoteDePropostas(lote);
  }
});

test("além do teto antigo: ?ate=420 mantém as propostas além da primeira página (não encolhe para 20)", async ({
  page,
}) => {
  test.skip(projeto !== "celular", "o lote é semeado uma vez, por um projeto só");
  // 21 pendentes: uma fica além da primeira página (20 por vez).
  const lote = await semearLoteDePropostas(21);
  try {
    await entrarComoAdmin(page, `graus-ate-${projeto}`);
    await page.goto(LISTA);
    await esperarHidratado(page.locator('[data-slot="proposta-gatilho"]').first());
    const itens = page.locator('[data-slot="accordion-item"]');
    await expect(itens).toHaveCount(20);
    // Quem está além da primeira página, entre as propostas deste lote.
    const visiveis = await itens.evaluateAll((els) =>
      els.map((e) => e.getAttribute("data-afirmacao")),
    );
    const alem = lote.filter((id) => !visiveis.includes(id));
    expect(alem.length, "o lote tem uma proposta além da primeira página").toBeGreaterThan(0);

    // O endereço que "Mostrar mais" geraria a partir de ate=400: além do teto antigo, a lista continua inteira
    // (antes do conserto, lerLimite convertia 420 em 20 e as propostas além ficavam inacessíveis).
    await page.goto(`${LISTA}?ate=420`);
    await esperarHidratado(page.locator('[data-slot="proposta-gatilho"]').first());
    await expect(
      page.locator(`[data-slot="accordion-item"][data-afirmacao="${alem[0]}"]`),
    ).toBeVisible();
    await expect(itens).toHaveCount(21);
  } finally {
    await removerLoteDePropostas(lote);
  }
});
