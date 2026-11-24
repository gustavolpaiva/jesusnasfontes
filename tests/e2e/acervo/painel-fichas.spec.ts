import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  removerFichasParaConferir,
  semearFichasParaConferir,
  slugsParaConferir,
  TITULOS_PARA_CONFERIR,
} from "../../support/ficha-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  lerTexto,
  semearAdminParaTeste,
} from "../../support/login-e2e";
import { gerarTotp } from "../../support/totp";

// Painel de fichas do Admin (ACER-07, D-02, D-03, D-05; UI-SPEC tela 12): a ficha entra como rascunho, o Admin de teste
// (com segundo fator, pela tela de verdade) confere cada página e a marca como verificada, e um Estudante em outra sessão
// passa a ler a ficha SEM ver o nome de quem verificou. As fichas são INVENTADAS e nada é gravado por atalho: conferir e
// verificar passam pelas funções reais do banco, pela Server Action. Cada teste semeia as próprias fichas (sufixo do
// projeto mais o do teste: celular e computador rodam o mesmo arquivo ao mesmo tempo no mesmo banco) e as remove no fim.

test.describe.configure({ mode: "default", timeout: 120_000 });
// Ações de servidor e gravação no banco sob a carga de três processos: o limite padrão de 5 s dá falso vermelho.
expect.configure({ timeout: 15_000 });

let projeto = "";
const semeados: string[] = [];

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  projeto = info.project.name;
});

test.afterAll(async () => {
  for (const sufixo of semeados) await removerFichasParaConferir(sufixo);
});

async function semear(teste: string) {
  const sufixo = `${projeto}-${teste}`;
  semeados.push(sufixo);
  await semearFichasParaConferir(sufixo);
  return {
    slugs: slugsParaConferir(sufixo),
    titulos: TITULOS_PARA_CONFERIR(sufixo),
  };
}

function vigiarHidratacao(page: Page): string[] {
  const avisos: string[] = [];
  page.on("console", (m) => {
    if (/hydrat/i.test(m.text())) avisos.push(m.text());
  });
  page.on("pageerror", (e) => {
    if (/hydrat/i.test(e.message)) avisos.push(e.message);
  });
  return avisos;
}

const semRolagemHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const PAGINAS = [
  "Conferi a página 39 a 53 no livro",
  "Conferi a página 7 no livro",
  "Conferi a página xi a xii no livro",
  "Conferi a página 101 no livro",
];

const verificar = (page: Page) =>
  page.getByRole("button", { name: "Marcar como verificada", exact: true });

// O botão de verificar fica `aria-disabled` (focável, nunca `disabled`): o Playwright o trata como não habilitado e não
// clica nele, e é isso mesmo que uma pessoa de teclado faz: foco e Enter.
async function acionar(botao: Locator): Promise<void> {
  await botao.focus();
  await botao.press("Enter");
}

async function abrirFicha(page: Page, slug: string): Promise<void> {
  await page.goto(`/admin/acervo/fichas/${slug}`);
  await esperarHidratado(verificar(page));
}

async function conferirNaTela(page: Page, nome: string): Promise<void> {
  const botao = page.getByRole("button", { name: nome });
  await botao.click();
  await expect(botao).toHaveCount(0);
}

test("caminho completo: rascunho, conferir cada página, verificar com diálogo, e o Estudante lê a ficha sem ver o nome do Admin", async ({
  browser,
  page,
}) => {
  const avisos = vigiarHidratacao(page);
  const { slugs, titulos } = await semear("completo");
  const admin = await entrarComoAdmin(page, `fichas-${projeto}`);

  // A entrada da administração lista a área, e a fila mostra a ficha como Rascunho com o progresso em texto.
  await expect(page.getByRole("link", { name: "Fichas a verificar", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Fichas a verificar", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fichas a verificar" })).toBeVisible();
  const linha = page.getByRole("listitem").filter({ hasText: titulos.conferir });
  await expect(linha.getByText("Rascunho", { exact: true })).toBeVisible();
  await expect(linha.getByText("0 de 4 páginas conferidas")).toBeVisible();
  expect(await semRolagemHorizontal(page)).toBe(true);

  await linha.getByRole("link", { name: titulos.conferir }).click();
  await esperarHidratado(verificar(page));
  await expect(page.getByRole("heading", { level: 1, name: titulos.conferir })).toBeVisible();
  await expect(
    page.getByText("Rascunho. Esta ficha não aparece para os Estudantes."),
  ).toBeVisible();
  // A ficha inteira no tamanho de leitura: tese, argumentos, trechos e limites.
  await expect(page.getByRole("heading", { level: 2, name: "Tese" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Argumentos" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Trechos citados" })).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "O que esta obra não pode dizer" }),
  ).toBeVisible();
  await expect(page.getByText("conferir na edição: Primeira edição de teste, 2001")).toHaveCount(4);

  // "Marcar como verificada" com páginas faltando: focável, aria-disabled, motivo em texto, e o foco vai à primeira página.
  await expect(verificar(page)).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText("Faltam 4 páginas a conferir.")).toBeVisible();
  await verificar(page).focus();
  await expect(verificar(page)).toBeFocused();
  await acionar(verificar(page));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: PAGINAS[0] as string })).toBeFocused();

  // Conferir cada página: um clique, sem diálogo; o chip troca e o foco segue para a próxima.
  await conferirNaTela(page, PAGINAS[0] as string);
  await expect(page.getByText(/^Conferida em \d{2}\/\d{2}\/\d{4}$/)).toHaveCount(1);
  await expect(page.getByRole("button", { name: PAGINAS[1] as string })).toBeFocused();
  await conferirNaTela(page, PAGINAS[1] as string);
  await conferirNaTela(page, PAGINAS[2] as string);
  await expect(page.getByText("Falta 1 página a conferir.")).toBeVisible();
  await expect(page.getByText("3 de 4 páginas conferidas")).toBeVisible();
  await conferirNaTela(page, PAGINAS[3] as string);
  await expect(page.getByText("4 de 4 páginas conferidas")).toBeVisible();
  await expect(page.getByText(/Falta|Faltam/)).toHaveCount(0);
  await expect(verificar(page)).not.toHaveAttribute("aria-disabled", "true");
  await expect(verificar(page)).toBeFocused();
  // Nada foi verificado ainda, e a ficha continua invisível ao Estudante.
  expect(
    await contar(
      "select count(*) as n from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
      [slugs.conferir],
    ),
  ).toBe(0);

  // O diálogo abre com o foco em Cancelar; Esc fecha e devolve o foco ao botão; nada muda.
  await verificar(page).click();
  const dialogo = page.getByRole("alertdialog");
  await expect(dialogo.getByRole("heading", { name: "Marcar como verificada?" })).toBeVisible();
  await expect(dialogo.getByText(/Você confirma que leu a ficha inteira/)).toBeVisible();
  await expect(dialogo.getByRole("button", { name: "Cancelar" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialogo).toHaveCount(0);
  await expect(verificar(page)).toBeFocused();

  // Confirmar verifica pela função do banco e mostra a mensagem do contrato.
  await verificar(page).click();
  await dialogo.getByRole("button", { name: "Marcar como verificada" }).click();
  await expect(
    page.getByText(/Ficha verificada em .+\. Agora ela aparece no Acervo\./),
  ).toBeVisible();
  // O foco vai à região da mensagem (que contém o `role="status"`), não fica no botão que sumiu.
  await expect(page.locator('[data-slot="aviso-da-acao"]')).toBeFocused();
  expect(
    await contar(
      "select count(*) as n from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
      [slugs.conferir],
    ),
  ).toBe(1);
  // Não há como desfazer: nenhum botão "Retirar verificação" nem "Conferi" sobra.
  await expect(page.getByRole("button", { name: /Retirar|Desfazer/ })).toHaveCount(0);
  expect(avisos, "aviso de hidratação").toEqual([]);

  // O Estudante, em outra sessão, passa a ler a ficha: "Verificada em", e nenhum rastro do Admin.
  const estudante = emailDeTeste(`fichas-est-${projeto}`);
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  await aba.goto(`/acervo/${slugs.conferir}`);
  await expect(aba.getByRole("heading", { level: 1, name: titulos.conferir })).toBeVisible();
  await expect(aba.getByText(/Verificada em /)).toBeVisible();
  const html = await aba.content();
  expect(html).not.toContain(admin.endereco);
  expect(html).not.toContain(admin.endereco.split("@")[0] as string);
  await contexto.close();

  // A fila agora a põe entre as verificadas, com a data.
  await page.goto("/admin/acervo/fichas");
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: titulos.conferir })
      .getByText(/^Verificada em \d{2}\/\d{2}\/\d{4}$/),
  ).toBeVisible();
});

test("edição 'A confirmar': o aviso diz o que fazer, o botão não abre o diálogo e o banco recusa mesmo assim", async ({
  page,
}) => {
  const { slugs } = await semear("edicao");
  await entrarComoAdmin(page, `fichas-edicao-${projeto}`);
  await abrirFicha(page, slugs.confirmar);
  const aviso =
    "A edição consultada desta ficha ainda não foi confirmada. Corrija a edição no arquivo da ficha e recarregue antes de verificar.";
  await expect(page.getByText(aviso)).toBeVisible();
  for (const nome of PAGINAS) await conferirNaTela(page, nome);
  await expect(page.getByText("4 de 4 páginas conferidas")).toBeVisible();
  // Tudo conferido, mas a edição não está confirmada: o botão continua aria-disabled, e acioná-lo não abre diálogo.
  await expect(verificar(page)).toHaveAttribute("aria-disabled", "true");
  await acionar(verificar(page));
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(
    await contar(
      "select count(*) as n from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
      [slugs.confirmar],
    ),
  ).toBe(0);
});

test("duas abas: conferir o mesmo item duas vezes não regrava; verificar a mesma ficha duas vezes não regrava; hash velho é recusado", async ({
  page,
}) => {
  const { slugs } = await semear("abas");
  await entrarComoAdmin(page, `fichas-abas-${projeto}`);
  const slug = slugs.umapagina;
  const nome = "Conferi a página 5 no livro";
  const registros = (acao: string) =>
    contar(
      "select count(*) as n from admin.registro_verificacao where acao = $1 and alvo like $2",
      [acao, `${slug}%`],
    );

  const aba1 = page;
  const aba2 = await page.context().newPage();
  await abrirFicha(aba1, slug);
  await abrirFicha(aba2, slug);
  await expect(aba2.getByRole("button", { name: nome })).toBeVisible();

  // A primeira aba confere; a segunda, ainda com o botão na tela, confere o MESMO item: ok, sem erro e sem segunda gravação.
  await conferirNaTela(aba1, nome);
  await expect(aba1.getByText("1 de 1 página conferida")).toBeVisible();
  await aba2.getByRole("button", { name: nome }).click();
  await expect(aba2.getByText("1 de 1 página conferida")).toBeVisible();
  await expect(aba2.locator('[data-slot="aviso-da-acao"] [role="alert"]')).toHaveCount(0);
  expect(await registros("conferir-item")).toBe(1);

  // As duas abas veem a ficha "pronta". A primeira verifica; a segunda, com o botão ainda na tela, é avisada.
  await aba1.reload();
  await aba2.reload();
  await esperarHidratado(verificar(aba1));
  await esperarHidratado(verificar(aba2));
  await verificar(aba1).click();
  await aba1
    .getByRole("alertdialog")
    .getByRole("button", { name: "Marcar como verificada" })
    .click();
  await expect(aba1.getByText(/Ficha verificada em /)).toBeVisible();
  const quando = await lerTexto(
    "select verificada_em::text as t from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
    [slug],
  );
  await verificar(aba2).click();
  await aba2
    .getByRole("alertdialog")
    .getByRole("button", { name: "Marcar como verificada" })
    .click();
  await expect(aba2.getByText(/já foi verificada em .+, em outra aba/)).toBeVisible();
  expect(await registros("verificar-ficha")).toBe(1);
  expect(
    await lerTexto(
      "select verificada_em::text as t from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
      [slug],
    ),
  ).toBe(quando);
  await aba2.close();
});

test("hash velho: a ficha ou a página mudou entre a leitura e o clique, e nada é marcado", async ({
  page,
}) => {
  const { slugs } = await semear("hash");
  await entrarComoAdmin(page, `fichas-hash-${projeto}`);
  const slug = slugs.umapagina;
  await abrirFicha(page, slug);

  // A página muda por baixo (a carga trouxe outro texto): conferir com o hash que a tela leu é recusado.
  await escrever(
    "update acervo.ficha_item set texto_pt = texto_pt || ' Mudou.' where ficha_id = (select id from acervo.fonte where slug = $1)",
    [slug],
  );
  await page.getByRole("button", { name: "Conferi a página 5 no livro" }).click();
  await expect(
    page.getByText(/Esta página mudou enquanto você a lia\. Nada foi marcado\./),
  ).toBeVisible();
  expect(
    await contar("select count(*) as n from acervo.conferencia_item where item_id like $1", [
      `${slug}/%`,
    ]),
  ).toBe(0);
  // "Recarregar a tela" traz a página nova, e agora conferir funciona.
  await page.getByRole("button", { name: "Recarregar a tela" }).click();
  await expect(page.getByText(/Mudou\./)).toBeVisible();
  await conferirNaTela(page, "Conferi a página 5 no livro");

  // A ficha muda depois de tudo conferido: verificar com o hash velho é recusado, e nenhuma verificação é gravada.
  await esperarHidratado(verificar(page));
  await escrever(
    "update acervo.ficha set tese_pt = tese_pt || ' Outra mudança.' where fonte_id = (select id from acervo.fonte where slug = $1)",
    [slug],
  );
  await verificar(page).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Marcar como verificada" })
    .click();
  await expect(
    page.getByText(/Esta ficha foi alterada enquanto você a lia\. Nada foi marcado\./),
  ).toBeVisible();
  expect(
    await contar(
      "select count(*) as n from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
      [slug],
    ),
  ).toBe(0);
});

test("segundo fator vencido: a mensagem do contrato com a ação, nada muda, e depois de confirmar volta à ficha; o retorno é só para a ficha", async ({
  page,
}) => {
  const { slugs } = await semear("mfa");
  const admin = await entrarComoAdmin(page, `fichas-mfa-${projeto}`);
  const slug = slugs.umapagina;
  await abrirFicha(page, slug);
  await conferirNaTela(page, "Conferi a página 5 no livro");
  await esperarHidratado(verificar(page));

  // O segundo fator vence no meio do fluxo (a linha da sessão some do banco).
  await escrever(
    'delete from admin.sessao_mfa where session_id in (select s.id from auth.session s join auth."user" u on u.id = s.user_id where u.email = $1)',
    [admin.endereco.toLowerCase()],
  );
  await verificar(page).click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Marcar como verificada" })
    .click();
  const erro = page
    .getByRole("alert")
    .filter({ hasText: "Sua verificação em duas etapas venceu." });
  await expect(erro).toContainText("Confirme de novo para marcar a ficha.");
  const acao = erro.getByRole("link", { name: "Confirmar o segundo fator" });
  await expect(acao).toHaveAttribute(
    "href",
    `/admin/segundo-fator?retorno=${encodeURIComponent(`/admin/acervo/fichas/${slug}`)}`,
  );
  expect(
    await contar(
      "select count(*) as n from acervo.verificacao_ficha where ficha_id = (select id from acervo.fonte where slug = $1)",
      [slug],
    ),
  ).toBe(0);

  // Confirmar de novo leva de volta à ficha (e só a ela).
  await acao.click();
  await expect(page).toHaveURL(/\/admin\/segundo-fator\?retorno=/);
  await page.getByLabel("Código de 6 dígitos").fill(gerarTotp(admin.chave, Date.now() + 30_000));
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/acervo/fichas/${slug}$`));
  await expect(page.getByRole("heading", { level: 1, name: /Obra de uma página/ })).toBeVisible();
  await expect(page.getByText("1 de 1 página conferida")).toBeVisible();
});

test("retorno externo do segundo fator é ignorado: depois de confirmar, o Admin cai na administração e nunca fora do site", async ({
  page,
}) => {
  const admin = await entrarComoAdmin(page, `fichas-retorno-${projeto}`);
  await escrever(
    'delete from admin.sessao_mfa where session_id in (select s.id from auth.session s join auth."user" u on u.id = s.user_id where u.email = $1)',
    [admin.endereco.toLowerCase()],
  );
  await page.goto("/admin/segundo-fator?retorno=https%3A%2F%2Fexterno.invalid%2Fpego");
  // O campo escondido só existe quando o retorno é aceito: o externo nem chega ao formulário.
  await expect(page.locator('input[name="retorno"]')).toHaveCount(0);
  await page.getByLabel("Código de 6 dígitos").fill(gerarTotp(admin.chave, Date.now() + 30_000));
  await page.getByRole("button", { name: "Confirmar" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
});

test("Estudante e Admin sem segundo fator: 404 e redirecionamento; ficha inexistente é 404; a ação com o cookie do Estudante não marca nada", async ({
  browser,
  page,
}) => {
  const { slugs } = await semear("acesso");
  await entrarComoAdmin(page, `fichas-acesso-${projeto}`);
  // Controle positivo: o Admin com segundo fator abre a fila e a ficha.
  for (const rota of ["/admin/acervo/fichas", `/admin/acervo/fichas/${slugs.umapagina}`]) {
    await page.goto(rota);
    await expect(
      page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toHaveCount(0);
  }
  await page.goto("/admin/acervo/fichas/ficha-que-nao-existe");
  await expect(
    page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
  ).toBeVisible();

  const estudante = emailDeTeste(`fichas-acesso-est-${projeto}`);
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  for (const rota of ["/admin/acervo/fichas", `/admin/acervo/fichas/${slugs.umapagina}`]) {
    await aba.goto(rota);
    await expect(
      aba.getByRole("heading", { level: 1, name: "Página não encontrada" }),
      rota,
    ).toBeVisible();
  }
  await contexto.close();

  const semFator = emailDeTeste(`fichas-sem-fator-${projeto}`);
  await semearAdminParaTeste(semFator);
  const contexto2 = await browser.newContext();
  const aba2 = await contexto2.newPage();
  await entrarPorLink(aba2, semFator, "Ative o segundo fator");
  for (const rota of ["/admin/acervo/fichas", `/admin/acervo/fichas/${slugs.umapagina}`]) {
    await aba2.goto(rota);
    await expect(aba2, rota).toHaveURL(/\/admin\/segundo-fator/);
  }
  await contexto2.close();
  expect(
    await contar("select count(*) as n from acervo.conferencia_item where item_id like $1", [
      `${slugs.umapagina}/%`,
    ]),
  ).toBe(0);
});
