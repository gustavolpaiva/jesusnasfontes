import { expect as esperar, type Locator, type Page, test } from "@playwright/test";
import {
  mudarHashDoTexto,
  removerLoteDePropostas,
  removerPropostas,
  type SemeadoDePropostas,
  semearLoteDePropostas,
  semearPropostas,
  tentarAprovar,
} from "../../support/citacao-e2e";
import { esperarEstudoAssentado, usarVozImediata } from "../../support/estudo-assentado";
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
import { confirmarSegundoFator } from "../../support/segundo-fator-e2e";

// O painel de graus propostos do Admin (ACER-06, ACER-10, D-04; UI-SPEC tela 13), de ponta a ponta. As propostas, as
// Citações, as fichas e o Admin são SINTÉTICOS e a aprovação passa pela função REAL do banco (`acervo.aprovar_afirmacao`)
// pela Server Action, com a sessão de um Admin de teste com segundo fator: nenhuma proposta ou Grau real é lido, aprovado
// ou corrigido por teste. Cada projeto (celular e computador) usa as SUAS Afirmações e fichas: os dois rodam este arquivo
// ao mesmo tempo no mesmo banco, então nenhum teste afirma o TOTAL da lista, só os seus itens (achados por id).
test.skip(
  !!process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo real: rode sem E2E_CONTEUDO_DIR",
);

test.describe.configure({ mode: "default", timeout: 120_000 });
// `expect.configure` DEVOLVE um `expect` novo (não muda o global): sob a carga de vários processos o padrão de 5 s dá falso vermelho.
const expect = esperar.configure({ timeout: 30000 });

let semeado: SemeadoDePropostas;
let projeto = "";
const lotes: string[][] = [];

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  projeto = info.project.name;
  semeado = await semearPropostas(projeto);
});

test.afterAll(async () => {
  if (semeado) await removerPropostas(semeado);
  for (const lote of lotes) await removerLoteDePropostas(lote);
});

const NAO_PODE_APARECER =
  /hydrat|validateDOMNesting|cannot be a descendant|cannot contain|did not match/i;
const RUIDO_DO_CADERNO = /anotacao-campo/;

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

const semRolagemHorizontal = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

const LISTA = "/admin/acervo/graus";
const itemDe = (page: Page, id: string) =>
  page.locator(`[data-slot="accordion-item"][data-afirmacao="${id}"]`);

/** O item da proposta, seguindo "Mostrar mais propostas" até achá-lo (outros testes põem propostas na frente). */
async function acharItem(page: Page, id: string): Promise<Locator> {
  const item = itemDe(page, id);
  for (let volta = 0; volta < 30; volta++) {
    if (await item.count()) return item;
    const mais = page.locator('[data-slot="mais-propostas"]');
    if (!(await mais.count())) break;
    const antes = page.url();
    await mais.click();
    await expect.poll(() => page.url()).not.toBe(antes);
  }
  await expect(item).toHaveCount(1);
  return item;
}

async function abrirLista(page: Page, filtro = ""): Promise<void> {
  await page.goto(filtro ? `${LISTA}?filtro=${filtro}` : LISTA);
  await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();
  await esperarHidratado(page.locator('[data-slot="proposta-gatilho"]').first());
}

/** Acha o item e abre o acordeão com um clique; devolve o item e o botão de aprovar. */
async function abrirProposta(page: Page, id: string): Promise<{ item: Locator; aprovar: Locator }> {
  const item = await acharItem(page, id);
  const gatilho = item.locator('[data-slot="proposta-gatilho"]');
  await esperarHidratado(gatilho);
  await gatilho.click();
  await expect(gatilho).toHaveAttribute("aria-expanded", "true");
  const aprovar = item.locator('[data-slot="aprovar-grau"]');
  await expect(aprovar).toBeVisible();
  // O conteúdo do acordeão só monta quando abre: espera o React estar ligado nas ESCOLHAS também
  // (o gatilho hidratado não garante o item aberto — clicar numa escolha antes disso perde o clique).
  await esperarHidratado(item.getByRole("radio").first());
  return { item, aprovar };
}

// O botão de aprovar sem efeito fica `aria-disabled` (focável, nunca `disabled`): é assim que uma pessoa de teclado o aciona.
async function acionar(botao: Locator): Promise<void> {
  await botao.focus();
  await botao.press("Enter");
}

const aprovacaoDe = (id: string) =>
  lerTexto("select grau as t from acervo.aprovacao_afirmacao where afirmacao_id = $1", [id]);
const quantasAprovacoes = (id: string) =>
  contar("select count(*) as n from acervo.aprovacao_afirmacao where afirmacao_id = $1", [id]);
const estudoDe = (id: string) =>
  lerTexto(
    "select e.slug as t from acervo.afirmacao a join conteudo.estudo e on e.id = a.estudo_id where a.id = $1",
    [id],
  );

/** O Estudante, em OUTRA sessão, abre o Estudo da Afirmação. */
async function comoEstudante(
  browser: import("@playwright/test").Browser,
  id: string,
  nome: string,
): Promise<{ aba: Page; fechar: () => Promise<void> }> {
  const email = emailDeTeste(`graus-est-${nome}-${projeto}`);
  await convidarParaTeste(email);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await usarVozImediata(aba);
  await entrarPorLink(aba, email);
  await aba.goto(`/estudos/${await estudoDe(id)}`);
  await esperarEstudoAssentado(aba);
  return { aba, fechar: () => contexto.close() };
}

const citacaoDe = (page: Page, id: string) =>
  page.locator(`[data-slot="citacao"][data-citacao-de="${id}"]`);

test("caminho completo: abrir, ler, aprovar o grau proposto, e o Estudante vê o par de selos em outra sessão, sem o nome de quem aprovou", async ({
  browser,
  page,
}) => {
  const console_ = vigiarConsole(page);
  const id = semeado.afirmacoes.aprovar;

  // Antes: o Estudante vê "Fonte em preparação" nessa frase, sem Citação.
  const antes = await comoEstudante(browser, id, "antes");
  await expect(citacaoDe(antes.aba, id)).toHaveCount(0);
  await antes.fechar();

  const admin = await entrarComoAdmin(page, `graus-feliz-${projeto}`);
  // A entrada da administração tem a área, com a pendência em meta.
  const entrada = page.getByRole("link", { name: "Graus propostos", exact: true });
  await expect(entrada).toBeVisible();
  await entrada.click();
  await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();
  await expect(
    page.getByText(
      "O agente propõe o Grau de certeza de cada Afirmação, com a Fonte ou a ficha que o justifica. Só o grau que você aprova aparece na tela.",
    ),
  ).toBeVisible();
  // A meta é medida do banco: o total é o de Afirmações, e o n é o de aprovações que valem.
  const total = await contar("select count(*) as n from acervo.afirmacao");
  await expect(page.locator('[data-slot="meta-dos-graus"]')).toHaveText(
    new RegExp(`^\\d+ de ${total} Afirmações com Citação aprovada$`),
  );
  await esperarHidratado(page.locator('[data-slot="proposta-gatilho"]').first());

  const { item, aprovar } = await abrirProposta(page, id);
  // A frase inteira, o Estudo e o id em meta, o chip Pendente e o Grau proposto no gatilho.
  const gatilho = item.locator('[data-slot="proposta-gatilho"]');
  await expect(gatilho.getByText("Pendente", { exact: true })).toBeVisible();
  await expect(gatilho.locator('[data-slot="selo-grau"]')).toHaveText("Posição majoritária");
  await expect(gatilho).toContainText(id);
  await expect(item.locator('[data-slot="frase-inteira"]')).toBeVisible();
  await expect(item.getByRole("link", { name: "Ver no Estudo" })).toHaveAttribute(
    "href",
    `/estudos/${await estudoDe(id)}`,
  );
  // Grau proposto, justificativa e a Citação proposta (Passagem).
  await expect(item.getByRole("heading", { level: 4, name: "Grau proposto" })).toBeVisible();
  await expect(item.locator('[data-slot="justificativa"]')).toContainText("Justificativa de teste");
  await expect(item.getByRole("heading", { level: 4, name: "Citações propostas" })).toBeVisible();
  await expect(item.locator('[data-slot="citacao-proposta"]')).toHaveCount(1);
  await expect(item.locator('[data-slot="citacao-proposta"] [data-slot="selo-nivel"]')).toHaveText(
    "Fonte primária",
  );
  await expect(item.locator('[data-slot="citacao-proposta"]')).toContainText("Lucas 2:7");
  // O grupo de escolha: três valores de 44 px, já marcado no proposto.
  const grupo = item.getByRole("radiogroup", { name: "Grau de certeza" });
  await expect(grupo.getByRole("radio")).toHaveCount(3);
  await expect(grupo.getByRole("radio", { name: "Posição majoritária" })).toBeChecked();
  for (const r of await grupo.getByRole("radio").all()) {
    const caixa = await r.boundingBox();
    expect(caixa?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  // Sem rejeitar, sem lote, sem seleção.
  await expect(page.getByRole("button", { name: /rejeit|recus|descart/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /todas|tudo|em lote/i })).toHaveCount(0);
  await expect(page.getByRole("checkbox")).toHaveCount(0);

  await expect(aprovar).toHaveText("Aprovar este grau");
  await expect(aprovar).not.toHaveAttribute("aria-disabled", "true");
  expect(await quantasAprovacoes(id)).toBe(0);
  expect(await semRolagemHorizontal(page)).toBe(true);

  await aprovar.click();
  const aviso = page.locator('[data-slot="aviso-dos-graus"]');
  await expect(aviso.getByRole("status")).toContainText(
    "Grau aprovado: Posição majoritária. A frase passa a mostrar a Citação no Estudo.",
  );
  await expect(aviso).toBeFocused();
  expect(await aprovacaoDe(id)).toBe("posicao-majoritaria");
  // Em "Pendentes" o item sai; em "Aprovadas" ele está, com "Aprovada: Posição majoritária".
  await expect(itemDe(page, id)).toHaveCount(0);
  await abrirLista(page, "aprovadas");
  const aprovada = await acharItem(page, id);
  await expect(aprovada.locator('[data-slot="chip-estado"]')).toHaveText(
    "Aprovada: Posição majoritária",
  );
  expect(console_, "aviso de hidratação ou de elemento inválido").toEqual([]);

  // Depois: o Estudante, em outra sessão, vê o par de selos, e nenhum rastro do Admin.
  const depois = await comoEstudante(browser, id, "depois");
  const botao = citacaoDe(depois.aba, id).locator('[data-slot="citacao-botao"]');
  await expect(botao).toBeVisible();
  await expect(botao.locator('[data-slot="selo-grau"]')).toHaveText("Posição majoritária");
  await expect(botao.locator('[data-slot="selo-nivel"]')).toHaveText("Fonte primária");
  const html = await depois.aba.content();
  expect(html).not.toContain(admin.endereco);
  expect(html).not.toContain(admin.endereco.split("@")[0] as string);
  await depois.fechar();
});

test("corrigir: trocar o valor muda o botão para 'Aprovar o grau corrigido' e grava o valor escolhido", async ({
  page,
}) => {
  const id = semeado.afirmacoes.corrigir;
  await entrarComoAdmin(page, `graus-corrige-${projeto}`);
  await abrirLista(page);
  const { item, aprovar } = await abrirProposta(page, id);
  // O proposto é Consenso; a Citação é de parágrafo de Fonte, com o trecho em <q lang="en"> e o nome da obra.
  await expect(item.getByRole("radio", { name: "Consenso" })).toBeChecked();
  const citacao = item.locator('[data-slot="citacao-proposta"]');
  await expect(citacao.locator("q")).toHaveAttribute("lang", "en");
  await expect(citacao.locator("q")).toContainText("a wise man");
  await expect(citacao.locator("q img")).toHaveCount(0); // o trecho é TEXTO, nunca marcação
  await expect(aprovar).toHaveText("Aprovar este grau");

  await item.getByRole("radio", { name: "Disputada" }).click();
  await expect(item.getByRole("radio", { name: "Disputada" })).toBeChecked();
  await expect(aprovar).toHaveText("Aprovar o grau corrigido");
  // Voltar ao valor proposto volta o rótulo.
  await item.getByRole("radio", { name: "Consenso" }).click();
  await expect(aprovar).toHaveText("Aprovar este grau");
  // Vários vai-e-vem seguidos: cada clique marca o valor na hora, sem segundo clique.
  for (const [nome, rotulo] of [
    ["Posição majoritária", "Aprovar o grau corrigido"],
    ["Consenso", "Aprovar este grau"],
    ["Disputada", "Aprovar o grau corrigido"],
    ["Consenso", "Aprovar este grau"],
    ["Disputada", "Aprovar o grau corrigido"],
  ] as const) {
    await item.getByRole("radio", { name: nome }).click();
    await expect(item.getByRole("radio", { name: nome })).toBeChecked();
    await expect(aprovar).toHaveText(rotulo);
  }

  await aprovar.click();
  await expect(page.locator('[data-slot="aviso-dos-graus"]').getByRole("status")).toContainText(
    "Grau aprovado: Disputada. A frase passa a mostrar a Citação no Estudo.",
  );
  expect(await aprovacaoDe(id)).toBe("disputada");
});

test("Aguardando ficha: o botão fica sem efeito com o motivo em texto, a ficha aparece 'A conferir', e o banco também recusa (P0003)", async ({
  page,
}) => {
  const id = semeado.afirmacoes.aguardando;
  await entrarComoAdmin(page, `graus-ficha-${projeto}`);
  await abrirLista(page);
  const { item, aprovar } = await abrirProposta(page, id);
  await expect(item.locator('[data-slot="chip-estado"]').first()).toHaveText("Aguardando ficha");
  await expect(
    item.locator('[data-slot="citacao-proposta"]').getByText("A conferir"),
  ).toBeVisible();
  await expect(item.locator('[data-slot="citacao-proposta"]')).toContainText("Trecho da ficha, p.");
  await expect(aprovar).toHaveAttribute("aria-disabled", "true");
  await expect(item.locator('[data-slot="motivo-do-grau"]')).toHaveText(
    /^Falta verificar a ficha de Obra de Teste .+\.$/,
  );
  await expect(aprovar).toHaveAccessibleDescription(/Falta verificar a ficha de/);
  // Focável, e sem efeito: nem clique nem Enter gravam ou mostram mensagem de sucesso.
  await aprovar.click({ force: true });
  await acionar(aprovar);
  await expect(page.locator('[data-slot="aviso-dos-graus"]').getByRole("status")).toHaveCount(0);
  expect(await quantasAprovacoes(id)).toBe(0);
  // A função do banco também recusa, com os hashes certos (a tela não é a única barreira).
  expect(await tentarAprovar(id, "consenso")).toBe("P0003");
  expect(await quantasAprovacoes(id)).toBe(0);
});

test("Texto mudou: a proposta de outra frase não se aprova, com o motivo em texto", async ({
  page,
}) => {
  const id = semeado.afirmacoes["texto-velho"];
  await entrarComoAdmin(page, `graus-velho-${projeto}`);
  await abrirLista(page);
  const { item, aprovar } = await abrirProposta(page, id);
  await expect(item.locator('[data-slot="chip-estado"]').first()).toHaveText("Texto mudou");
  await expect(aprovar).toHaveAttribute("aria-disabled", "true");
  await expect(item.locator('[data-slot="motivo-do-grau"]')).toHaveText(
    "Esta frase mudou depois da proposta. Recarregue as propostas.",
  );
  await acionar(aprovar);
  expect(await quantasAprovacoes(id)).toBe(0);
});

test("o texto muda entre a leitura e o clique: o banco recusa (40001), nada é gravado, e a tela pede para recarregar", async ({
  page,
}) => {
  const id = semeado.afirmacoes.corrida;
  await entrarComoAdmin(page, `graus-corrida-${projeto}`);
  await abrirLista(page);
  const { item, aprovar } = await abrirProposta(page, id);
  await expect(item.locator('[data-slot="chip-estado"]').first()).toHaveText("Pendente");
  const original = await mudarHashDoTexto(id);
  try {
    await aprovar.click();
    const recusa = item.locator('[data-slot="recusa-do-grau"]');
    await expect(recusa.getByRole("alert")).toContainText(
      "Esta frase mudou depois da proposta. Recarregue as propostas.",
    );
    expect(await quantasAprovacoes(id)).toBe(0);
    await expect(page.locator('[data-slot="aviso-dos-graus"]').getByRole("status")).toHaveCount(0);
    // Recarregar traz o estado novo: a proposta é de outra frase.
    await recusa.getByRole("button", { name: "Recarregar as propostas" }).click();
    await expect(item.locator('[data-slot="chip-estado"]').first()).toHaveText("Texto mudou");
  } finally {
    await escrever("update acervo.afirmacao set texto_hash = $2 where id = $1", [id, original]);
  }
});

test("filtros com contagens: Pendentes, Aprovadas e Todas, e a Aprovada mostra o Grau aprovado", async ({
  page,
}) => {
  const aprovada = semeado.afirmacoes.aprovada;
  // A que o primeiro teste aprovou já não é pendente; "Aguardando ficha" segue na lista de pendentes (não está aprovada).
  const pendente = semeado.afirmacoes.aguardando;
  await entrarComoAdmin(page, `graus-filtros-${projeto}`);
  await abrirLista(page, "todas");
  const nav = page.getByRole("navigation", { name: "Filtro das propostas" });
  const numero = async (nome: string) => {
    const t =
      (await nav.getByRole("link", { name: new RegExp(`^${nome} \\(\\d+\\)$`) }).innerText()) ?? "";
    return Number(/\((\d+)\)/.exec(t)?.[1]);
  };
  const [p, a, t] = [await numero("Pendentes"), await numero("Aprovadas"), await numero("Todas")];
  // Do mesmo instantâneo: pendentes e aprovadas somam todas, sempre.
  expect(p + a).toBe(t);
  await expect(nav.getByRole("link", { name: /^Todas/ })).toHaveAttribute("aria-current", "true");

  // Todas: a aprovada traz "Aprovada: Disputada" (corrigida em relação ao proposto), e as outras os seus estados.
  const itemAprovada = await acharItem(page, aprovada);
  await expect(itemAprovada.locator('[data-slot="chip-estado"]').first()).toHaveText(
    "Aprovada: Disputada",
  );
  await expect(itemAprovada.locator('[data-slot="selo-grau"]')).toHaveText("Consenso");
  // Aberta, o valor marcado é o que foi aprovado (Disputada), não o proposto.
  await itemAprovada.locator('[data-slot="proposta-gatilho"]').click();
  await expect(itemAprovada.getByRole("radio", { name: "Disputada" })).toBeChecked();
  await expect(itemAprovada.locator('[data-slot="aprovar-grau"]')).toHaveText(
    "Aprovar o grau corrigido",
  );

  // Pendentes: não traz a aprovada, traz a pendente.
  await nav.getByRole("link", { name: /^Pendentes/ }).click();
  await expect(page).toHaveURL(new RegExp(`${LISTA}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();
  await expect(itemDe(page, aprovada)).toHaveCount(0);
  await acharItem(page, pendente);
  // Aprovadas: traz a aprovada, não traz a pendente.
  await nav.getByRole("link", { name: /^Aprovadas/ }).click();
  await expect(page).toHaveURL(/filtro=aprovadas/);
  await acharItem(page, aprovada);
  await expect(itemDe(page, pendente)).toHaveCount(0);
});

test("segundo fator vencido: a mensagem com a ação de confirmar, nada muda, e depois de confirmar volta à lista", async ({
  page,
}) => {
  const id = semeado.afirmacoes.ficha;
  const admin = await entrarComoAdmin(page, `graus-mfa-${projeto}`);
  await abrirLista(page);
  const { item, aprovar } = await abrirProposta(page, id);
  // A ficha dessa Citação está verificada: nada impede aprovar, a não ser o segundo fator que vai vencer.
  await expect(aprovar).not.toHaveAttribute("aria-disabled", "true");
  await escrever(
    'delete from admin.sessao_mfa where session_id in (select s.id from auth.session s join auth."user" u on u.id = s.user_id where u.email = $1)',
    [admin.endereco.toLowerCase()],
  );
  await aprovar.click();
  const erro = item.locator('[data-slot="recusa-do-grau"]').getByRole("alert");
  await expect(erro).toContainText("Sua verificação em duas etapas venceu.");
  await expect(erro).toContainText("Confirme de novo para aprovar o grau.");
  const acao = erro.getByRole("link", { name: "Confirmar o segundo fator" });
  await expect(acao).toHaveAttribute(
    "href",
    `/admin/segundo-fator?retorno=${encodeURIComponent(LISTA)}`,
  );
  expect(await quantasAprovacoes(id)).toBe(0);
  await expect(page.locator('[data-slot="aviso-dos-graus"]').getByRole("status")).toHaveCount(0);

  await acao.click();
  await expect(page).toHaveURL(/\/admin\/segundo-fator\?retorno=/);
  await confirmarSegundoFator(page, admin.chave);
  await expect(page).toHaveURL(new RegExp(`${LISTA}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();
});

test("acesso: Estudante e Admin sem segundo fator não entram na lista; a rota não revela que existe", async ({
  browser,
  page,
}) => {
  await entrarComoAdmin(page, `graus-acesso-${projeto}`);
  // Controle positivo: o Admin com segundo fator abre a lista.
  await page.goto(LISTA);
  await expect(page.getByRole("heading", { level: 1, name: "Página não encontrada" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("heading", { level: 1, name: "Graus propostos" })).toBeVisible();

  const estudante = emailDeTeste(`graus-acesso-est-${projeto}`);
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  await aba.goto(LISTA);
  await expect(aba.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();
  // Nenhuma frase, justificativa ou id de proposta vaza para a página 404.
  const html = await aba.content();
  expect(html).not.toContain("Justificativa de teste");
  expect(html).not.toContain(semeado.afirmacoes.aprovar);
  await contexto.close();

  const semFator = emailDeTeste(`graus-sem-fator-${projeto}`);
  await semearAdminParaTeste(semFator);
  const contexto2 = await browser.newContext();
  const aba2 = await contexto2.newPage();
  await entrarPorLink(aba2, semFator, "Ative o segundo fator");
  await aba2.goto(LISTA);
  await expect(aba2).toHaveURL(/\/admin\/segundo-fator/);
  await contexto2.close();
});

test("20 por vez: 'Mostrar mais propostas' traz as seguintes, sem perder o que estava aberto", async ({
  page,
}) => {
  test.skip(projeto !== "celular", "o lote é semeado uma vez, por um projeto só");
  const lote = await semearLoteDePropostas(22);
  lotes.push(lote);
  await entrarComoAdmin(page, `graus-lote-${projeto}`);
  await abrirLista(page);
  const itens = page.locator('[data-slot="accordion-item"]');
  await expect(itens).toHaveCount(20);
  // Abre o primeiro e conta: o que está aberto continua aberto depois de "Mostrar mais".
  const primeiro = itens.first();
  await primeiro.locator('[data-slot="proposta-gatilho"]').click();
  await expect(primeiro.locator('[data-slot="proposta-gatilho"]')).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await page.locator('[data-slot="mais-propostas"]').click();
  await expect(page).toHaveURL(/ate=40/);
  await expect.poll(() => itens.count()).toBeGreaterThan(20);
  await expect(
    page
      .locator('[data-slot="accordion-item"][data-afirmacao]')
      .first()
      .locator('[data-slot="proposta-gatilho"]'),
  ).toHaveAttribute("aria-expanded", "true");
  // Valores ruins no endereço valem 20.
  await page.goto(`${LISTA}?ate=999999&filtro=qualquer`);
  await expect(itens).toHaveCount(20);
});

// O estado vazio só se prova num banco SEM nenhuma proposta, e os outros testes deste arquivo e o das varreduras põem as
// suas no banco compartilhado da execução. Roda sozinho: `E2E_GRAUS_VAZIO=1 pnpm test:e2e ... -g "estado vazio"`.
test("estado vazio: 'Nenhuma proposta pendente' com a frase do contrato", async ({ page }) => {
  test.skip(process.env.E2E_GRAUS_VAZIO !== "1", "só num banco sem propostas (veja o comentário)");
  test.skip(projeto !== "computador", "uma vez só");
  await removerPropostas(semeado);
  await entrarComoAdmin(page, `graus-vazio-${projeto}`);
  await page.goto(LISTA);
  await expect(
    page.getByRole("heading", { level: 2, name: "Nenhuma proposta pendente" }),
  ).toBeVisible();
  await expect(
    page.getByText("As propostas aparecem aqui quando o arquivo de graus for carregado."),
  ).toBeVisible();
  await expect(page.locator('[data-slot="meta-dos-graus"]')).toHaveText(
    /^0 de \d+ Afirmações com Citação aprovada$/,
  );
});
