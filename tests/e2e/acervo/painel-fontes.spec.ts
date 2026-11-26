import { expect as esperar, type Page, test } from "@playwright/test";
import {
  cargarFonteDoArquivo,
  LIMITES_DO_ARQUIVO,
  removerFonteDeTeste,
} from "../../support/fonte-painel-e2e";
import { esperarHidratado } from "../../support/hidratacao";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  lerTexto,
  semearAdminParaTeste,
} from "../../support/login-e2e";

// Painel de Fontes do Admin (ACER-08, ACER-09; UI-SPEC tela 11): incluir e editar, a recusa de ACER-09 e a de licença
// com a mensagem do contrato e o foco no campo, a Fonte do arquivo só com limites e publicação, o conflito com a carga e
// a reversão, e a 404 para quem não é Admin com segundo fator. As Fontes de teste têm o sufixo do projeto (celular e
// computador rodam o mesmo arquivo ao mesmo tempo no mesmo banco) e saem no fim.

test.describe.configure({ mode: "default" });
// Ações de servidor e gravação no banco sob a carga de três processos: o limite padrão de 5 s dá falso vermelho.
// `expect.configure` DEVOLVE um `expect` novo (não muda o global): é ELE que o arquivo usa.
const expect = esperar.configure({ timeout: 15_000 });

let sufixo = "";
const criadas: string[] = [];

// biome-ignore lint/correctness/noEmptyPattern: o Playwright exige o padrão de desestruturação no primeiro argumento
test.beforeAll(async ({}, info) => {
  sufixo = info.project.name;
});

test.afterAll(async () => {
  for (const slug of criadas) await removerFonteDeTeste(slug);
});

const MSG_ACER09 =
  "Obra protegida não pode ter texto integral. Guarde só a ficha, com trechos curtos de até 300 caracteres.";
const MSG_LICENCA = "Texto integral precisa de licença e de endereço https da origem.";

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

async function abrirFormularioNovo(page: Page): Promise<void> {
  await page.goto("/admin/acervo/fontes/novo");
  await expect(page.getByRole("heading", { level: 1, name: "Incluir Fonte" })).toBeVisible();
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));
}

test("Admin inclui uma Fonte pelo painel com seção colada e a vê na lista como do painel; a lista chega pelo Menu e pela entrada", async ({
  page,
}) => {
  const avisos = vigiarHidratacao(page);
  await entrarComoAdmin(page, `painel-incluir-${sufixo}`);
  // A entrada da administração lista as áreas.
  await expect(page.getByRole("link", { name: "Fontes", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Fontes", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fontes" })).toBeVisible();
  await page.getByRole("link", { name: "Incluir Fonte" }).click();
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));

  const titulo = `Obra do painel ${sufixo}`;
  const slug = `obra-do-painel-${sufixo}`;
  criadas.push(slug);
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page
    .getByLabel("Origem do texto (endereço https)")
    .fill("https://exemplo.invalid/obra-de-teste");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("button", { name: "Adicionar seção" }).click();
  await page.getByLabel("Título", { exact: true }).nth(1).fill("Capítulo único");
  await page
    .getByLabel("Texto (parágrafos separados por uma linha em branco)")
    .fill("Primeiro parágrafo do teste.\n\nSegundo parágrafo do teste.");
  await page.getByLabel("Resumo em português").fill("Resumo de teste.");
  await page.getByLabel("Palavras-chave em português").fill("um, dois");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/acervo/fontes/${slug}\\?salvo=1`));
  await expect(page.getByText("Fonte salva.")).toBeVisible();
  expect(
    await contar("select count(*) as n from acervo.fonte_paragrafo where id like $1", [
      `${slug}/%`,
    ]),
  ).toBe(2);
  expect(
    await lerTexto("select origem_registro as t from acervo.fonte where slug = $1", [slug]),
  ).toBe("painel");

  await page.goto("/admin/acervo/fontes");
  const linha = page.getByRole("listitem").filter({ hasText: titulo });
  await expect(linha.getByText("do painel", { exact: true })).toBeVisible();
  await expect(linha.getByText("Não publicada", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: `Editar ${titulo}` })).toBeVisible();
  expect(await semRolagemHorizontal(page)).toBe(true);

  // Editar: o formulário volta com o que foi salvo, inclusive o texto da seção.
  await page.getByRole("link", { name: `Editar ${titulo}` }).click();
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));
  await expect(page.getByLabel("Texto (parágrafos separados por uma linha em branco)")).toHaveValue(
    "Primeiro parágrafo do teste.\n\nSegundo parágrafo do teste.",
  );
  expect(avisos, "aviso de hidratação").toEqual([]);
});

test("obra protegida com texto integral não salva: a mensagem do contrato fica no campo, o foco vai para ele e nada é gravado", async ({
  page,
}) => {
  const avisos = vigiarHidratacao(page);
  await entrarComoAdmin(page, `painel-acer09-${sufixo}`);
  await abrirFormularioNovo(page);
  const titulo = `Obra protegida ${sufixo}`;
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("checkbox", { name: "Obra protegida" }).click();

  const salvar = page.getByRole("button", { name: "Salvar Fonte" });
  await salvar.click();
  await expect(page.getByText(MSG_ACER09)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Obra protegida" })).toBeFocused();
  await expect(page.getByRole("checkbox", { name: "Obra protegida" })).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  // O botão nunca é desabilitado, e o que foi digitado continua no formulário.
  await expect(salvar).toBeEnabled();
  await expect(page.getByLabel("Título", { exact: true })).toHaveValue(titulo);
  expect(await contar("select count(*) as n from acervo.fonte where titulo = $1", [titulo])).toBe(
    0,
  );
  expect(await semRolagemHorizontal(page)).toBe(true);

  // Controle positivo: desmarcada a proteção, a mesma Fonte salva.
  await page.getByRole("checkbox", { name: "Obra protegida" }).click();
  await salvar.click();
  await expect(page).toHaveURL(/\?salvo=1/);
  criadas.push(`obra-protegida-${sufixo}`);
  expect(await contar("select count(*) as n from acervo.fonte where titulo = $1", [titulo])).toBe(
    1,
  );
  expect(avisos, "aviso de hidratação").toEqual([]);
});

test("texto integral sem licença, ou com endereço sem https, mostra a mensagem do contrato no campo certo", async ({
  page,
}) => {
  await entrarComoAdmin(page, `painel-licenca-${sufixo}`);
  await abrirFormularioNovo(page);
  const titulo = `Sem licença ${sufixo}`;
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByText(MSG_LICENCA)).toBeVisible();
  await expect(page.getByLabel("Licença (código)")).toBeFocused();

  // O endereço sem https é recusado pelo contrato do formulário, com a mensagem do endereço e o foco nele.
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByLabel("Origem do texto (endereço https)").fill("http://exemplo.invalid/obra");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByText("O endereço precisa começar com https://.")).toBeVisible();
  await expect(page.getByLabel("Origem do texto (endereço https)")).toBeFocused();
  expect(await contar("select count(*) as n from acervo.fonte where titulo = $1", [titulo])).toBe(
    0,
  );
});

test("palavras-chave de uma seção acima do teto: o erro aparece no campo, o campo fica inválido com o foco, e nada é gravado (revisão da fase, plano 02-24)", async ({
  page,
}) => {
  await entrarComoAdmin(page, `painel-palavras-${sufixo}`);
  await abrirFormularioNovo(page);
  const titulo = `Palavras demais ${sufixo}`;
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("button", { name: "Adicionar seção" }).click();
  await page.getByLabel("Título", { exact: true }).nth(1).fill("Capítulo único");
  await page
    .getByLabel("Texto (parágrafos separados por uma linha em branco)")
    .fill("Um parágrafo do teste.");
  const palavras = page.getByLabel("Palavras-chave em português");
  await palavras.fill(`${"a".repeat(1_000)}, ${"b".repeat(1_001)}`);
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(palavras).toHaveAttribute("aria-invalid", "true");
  await expect(palavras).toBeFocused();
  // O erro está ligado ao campo (aria-describedby) e tem texto; a ajuda "Separadas por vírgula." segue ligada também.
  const descricao = (await palavras.getAttribute("aria-describedby")) ?? "";
  expect(descricao.split(" ").length).toBe(2);
  const erro = page.locator(`[id="${descricao.split(" ")[1]}"]`);
  await expect(erro).toBeVisible();
  expect(((await erro.textContent()) ?? "").trim().length).toBeGreaterThan(0);
  expect(await contar("select count(*) as n from acervo.fonte where titulo = $1", [titulo])).toBe(
    0,
  );
});

test("Fonte do arquivo: o painel só oferece limites e publicação; o conflito com a carga aparece e 'Reverter ao arquivo' o desfaz", async ({
  page,
}) => {
  const slug = `arquivo-painel-${sufixo}`;
  criadas.push(slug);
  await cargarFonteDoArquivo(slug);
  const avisos = vigiarHidratacao(page);
  await entrarComoAdmin(page, `painel-conflito-${sufixo}`);

  await page.goto(`/admin/acervo/fontes/${slug}`);
  await expect(
    page.getByRole("heading", { level: 1, name: `Fonte do arquivo ${slug}` }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Esta Fonte vem do arquivo versionado. O painel edita o resumo, as palavras-chave, os limites e a publicação.",
    ),
  ).toBeVisible();
  // Os campos do arquivo são só leitura: nenhum campo de título, autor, origem ou licença para digitar.
  for (const rotulo of ["Título", "Autor", "Origem do texto (endereço https)", "Licença (código)"])
    await expect(page.getByLabel(rotulo, { exact: true })).toHaveCount(0);
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));

  // Edita os limites no painel.
  const limites = page.getByLabel("O que esta Fonte não pode dizer");
  await expect(limites).toHaveValue(LIMITES_DO_ARQUIVO);
  await limites.fill("Limites reescritos pelo painel.");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByText("Fonte salva.")).toBeVisible();

  // Uma nova carga do mesmo arquivo recusa a Fonte e não sobrescreve.
  const resultado = await cargarFonteDoArquivo(slug);
  expect(resultado.conflitos).toEqual([{ slug, campos: ["limites_pt"] }]);
  expect(await lerTexto("select limites_pt as t from acervo.fonte where slug = $1", [slug])).toBe(
    "Limites reescritos pelo painel.",
  );

  await page.reload();
  const aviso = page.locator('[data-slot="aviso-de-conflito"]');
  await expect(aviso).toContainText(
    "A última carga do arquivo recusou esta Fonte porque ela foi editada no painel: O que esta Fonte não pode dizer. Nada foi sobrescrito.",
  );
  await expect(aviso).toContainText(
    "Ou atualize o arquivo para refletir o painel e rode a carga de novo.",
  );
  expect(await semRolagemHorizontal(page)).toBe(true);

  // O diálogo nomeia o que se perde, abre com o foco em Cancelar e Esc devolve o foco ao botão que o abriu.
  const abrir = aviso.getByRole("button", { name: "Reverter ao arquivo" });
  await esperarHidratado(abrir);
  await abrir.click();
  const dialogo = page.getByRole("alertdialog");
  await expect(dialogo.getByRole("heading", { name: "Reverter ao arquivo?" })).toBeVisible();
  await expect(dialogo).toContainText(
    "Os campos O que esta Fonte não pode dizer voltam ao que está no arquivo. A edição feita no painel é perdida.",
  );
  await expect(dialogo.getByRole("button", { name: "Cancelar" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialogo).toHaveCount(0);
  await expect(abrir).toBeFocused();

  await abrir.click();
  await dialogo.getByRole("button", { name: "Reverter ao arquivo" }).click();
  await expect(page.locator('[data-slot="aviso-de-conflito"]')).toHaveCount(0);
  expect(await lerTexto("select limites_pt as t from acervo.fonte where slug = $1", [slug])).toBe(
    LIMITES_DO_ARQUIVO,
  );
  await expect(page.getByLabel("O que esta Fonte não pode dizer")).toHaveValue(LIMITES_DO_ARQUIVO);
  // A carga seguinte volta ao normal.
  expect((await cargarFonteDoArquivo(slug)).conflitos).toEqual([]);
  expect(avisos, "aviso de hidratação").toEqual([]);
});

test("resumo e palavras-chave de uma seção do arquivo se editam, com o rótulo de IA sempre visível", async ({
  page,
}) => {
  const slug = `arquivo-resumo-${sufixo}`;
  criadas.push(slug);
  await cargarFonteDoArquivo(slug);
  await entrarComoAdmin(page, `painel-resumo-${sufixo}`);
  await page.goto(`/admin/acervo/fontes/${slug}`);
  await page.getByRole("link", { name: "Editar resumo de Livro 18" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Livro 18" })).toBeVisible();
  await expect(
    page.getByText("Resumo auxiliar de busca, escrito por IA. Não é tradução nem foi revisado."),
  ).toBeVisible();
  await esperarHidratado(page.getByRole("button", { name: "Salvar resumo" }));
  await page.getByLabel("Resumo em português").fill("Resumo reescrito no painel.");
  await page.getByLabel("Palavras-chave em português").fill("alfa, beta");
  await page.getByRole("button", { name: "Salvar resumo" }).click();
  await expect(page.getByText("Resumo salvo.")).toBeVisible();
  expect(
    await lerTexto("select resumo_pt as t from acervo.fonte_secao where id = $1", [`${slug}/18`]),
  ).toBe("Resumo reescrito no painel.");
  // A carga seguinte o trata como edição do painel.
  expect((await cargarFonteDoArquivo(slug)).conflitos).toEqual([
    { slug, campos: expect.arrayContaining(["18:resumo_pt", "18:palavras_chave_pt"]) },
  ]);
});

test("Estudante recebe a 404 nas quatro rotas do painel; Admin sem segundo fator vai para a tela dele", async ({
  browser,
  page,
}) => {
  const slug = `arquivo-404-${sufixo}`;
  criadas.push(slug);
  await cargarFonteDoArquivo(slug);
  // Controle positivo: o Admin com segundo fator abre as quatro.
  await entrarComoAdmin(page, `painel-404-${sufixo}`);
  const rotas = [
    "/admin/acervo/fontes",
    "/admin/acervo/fontes/novo",
    `/admin/acervo/fontes/${slug}`,
    `/admin/acervo/fontes/${slug}/secoes/18`,
  ];
  for (const rota of rotas) {
    await page.goto(rota);
    await expect(
      page.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toHaveCount(0);
  }

  const estudante = emailDeTeste(`painel-estudante-${sufixo}`);
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  for (const rota of rotas) {
    await aba.goto(rota);
    await expect(
      aba.getByRole("heading", { level: 1, name: "Página não encontrada" }),
      rota,
    ).toBeVisible();
  }
  await contexto.close();

  const semFator = emailDeTeste(`painel-sem-fator-${sufixo}`);
  await semearAdminParaTeste(semFator);
  const ctx2 = await browser.newContext();
  const aba2 = await ctx2.newPage();
  await entrarPorLink(aba2, semFator, "Ative o segundo fator");
  for (const rota of rotas) {
    await aba2.goto(rota);
    await expect(aba2, rota).toHaveURL(/\/admin\/segundo-fator/);
  }
  await ctx2.close();
});

test("a ação de salvar recusa no servidor quem não é Admin: a mesma requisição do Admin, com o cookie do Estudante, não cria nada", async ({
  browser,
  page,
}) => {
  await entrarComoAdmin(page, `painel-replay-${sufixo}`);
  await abrirFormularioNovo(page);
  const titulo = `Replay ${sufixo}`;
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  const pedido = page.waitForRequest((r) => r.method() === "POST" && !!r.headers()["next-action"]);
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  const real = await pedido;
  await expect(page).toHaveURL(/\?salvo=1/);
  criadas.push(`replay-${sufixo}`);
  expect(await contar("select count(*) as n from acervo.fonte where titulo = $1", [titulo])).toBe(
    1,
  );

  const estudante = emailDeTeste(`painel-replay-est-${sufixo}`);
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  const alvo = `Invasor ${sufixo}`;
  const cabecalhos: Record<string, string> = {
    ...real.headers(),
    origin: new URL(real.url()).origin,
  };
  delete cabecalhos.cookie;
  delete cabecalhos["content-length"];
  const corpo = real.postData() ?? "";
  expect(corpo).toContain(titulo);
  const resposta = await contexto.request.post(new URL(real.url()).pathname, {
    headers: cabecalhos,
    data: corpo.replace(titulo, alvo),
    maxRedirects: 0,
  });
  expect(resposta.status()).toBe(404);
  expect(await contar("select count(*) as n from acervo.fonte where titulo = $1", [alvo])).toBe(0);
  await contexto.close();
});

test("seção salva não se remove nem se sobrescreve pelo formulário: salvar A, adicionar B sem sair da página e salvar mantém as duas", async ({
  page,
}) => {
  await entrarComoAdmin(page, `painel-secoes-${sufixo}`);
  await abrirFormularioNovo(page);
  const titulo = `Duas secoes ${sufixo}`;
  const slug = `duas-secoes-${sufixo}`;
  criadas.push(slug);
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page).toHaveURL(/\?salvo=1/);
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));

  // Já na edição: adiciona a seção A e salva, SEM recarregar a página.
  await page.getByRole("button", { name: "Adicionar seção" }).click();
  await page.getByLabel("Título", { exact: true }).nth(1).fill("Seção A");
  await page
    .getByLabel("Texto (parágrafos separados por uma linha em branco)")
    .fill("Texto da seção A.");
  await expect(page.getByRole("button", { name: "Remover esta seção" })).toHaveCount(1);
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByText("Fonte salva.")).toBeVisible();

  // A seção salva já não é "nova": não há como removê-la daqui (e o endereço dela ficou no estado).
  await expect(page.getByRole("button", { name: "Remover esta seção" })).toHaveCount(0);

  // Adiciona B na mesma página e salva: B ganha OUTRO endereço e A continua intacta.
  await page.getByRole("button", { name: "Adicionar seção" }).click();
  await page.getByLabel("Título", { exact: true }).nth(2).fill("Seção B");
  await page
    .getByLabel("Texto (parágrafos separados por uma linha em branco)")
    .nth(1)
    .fill("Texto da seção B.");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByText("Fonte salva.")).toBeVisible();
  await expect
    .poll(() =>
      contar("select count(*) as n from acervo.fonte_secao where id like $1", [`${slug}/%`]),
    )
    .toBe(2);
  await expect
    .poll(() =>
      lerTexto("select titulo as t from acervo.fonte_secao where id = $1", [`${slug}/secao-1`]),
    )
    .toBe("Seção A");
  await expect
    .poll(() =>
      lerTexto("select titulo as t from acervo.fonte_secao where id = $1", [`${slug}/secao-2`]),
    )
    .toBe("Seção B");
  await expect
    .poll(() =>
      lerTexto("select texto as t from acervo.fonte_paragrafo where secao_id = $1", [
        `${slug}/secao-1`,
      ]),
    )
    .toBe("Texto da seção A.");
});

test("formulário com a Fonte já alterada por outra aba é recusado com aviso e nada é sobrescrito; o digitado fica", async ({
  page,
}) => {
  await entrarComoAdmin(page, `painel-revisao-${sufixo}`);
  await abrirFormularioNovo(page);
  const titulo = `Duas abas ${sufixo}`;
  const slug = `duas-abas-${sufixo}`;
  criadas.push(slug);
  await page.getByLabel("Título", { exact: true }).fill(titulo);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page).toHaveURL(/\?salvo=1/);

  // Segunda aba do MESMO Admin, aberta na mesma revisão.
  const aba2 = await page.context().newPage();
  await aba2.goto(`/admin/acervo/fontes/${slug}`);
  await esperarHidratado(aba2.getByRole("button", { name: "Salvar Fonte" }));
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));

  // A primeira aba salva uma mudança.
  await page.getByLabel("Autor", { exact: true }).fill("Autor da primeira aba");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  // A faixa "Fonte salva." da criação já está na página: o que prova o salvamento é o banco.
  await expect
    .poll(() => lerTexto("select autor as t from acervo.fonte where slug = $1", [slug]))
    .toBe("Autor da primeira aba");

  // A segunda ainda tem a revisão velha: recusada, sem sobrescrever, e o que ela digitou continua.
  await aba2.getByLabel("Autor", { exact: true }).fill("Autor da segunda aba");
  await aba2.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(
    aba2.getByText(/Esta Fonte foi alterada por outra pessoa, ou por uma carga do arquivo/),
  ).toBeVisible({ timeout: 15_000 });
  await expect(aba2.getByLabel("Autor", { exact: true })).toHaveValue("Autor da segunda aba");
  await expect
    .poll(() => lerTexto("select autor as t from acervo.fonte where slug = $1", [slug]))
    .toBe("Autor da primeira aba");
  // Salvar de novo na primeira aba (que já tem a revisão nova) continua funcionando.
  await page.getByLabel("Autor", { exact: true }).fill("Autor, de novo");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByText("Fonte salva.")).toBeVisible();
  await expect
    .poll(() => lerTexto("select autor as t from acervo.fonte where slug = $1", [slug]))
    .toBe("Autor, de novo");
});

test("com o salvamento no ar a lista de seções não muda: nem entra, nem sai seção; cada seção fica com o endereço da própria resposta", async ({
  page,
}) => {
  await entrarComoAdmin(page, `painel-voo-${sufixo}`);
  await abrirFormularioNovo(page);
  const slug = `em-voo-${sufixo}`;
  criadas.push(slug);
  await page.getByLabel("Título", { exact: true }).fill(`Em voo ${sufixo}`);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page).toHaveURL(/\?salvo=1/);
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));

  // Duas seções novas, A e B, em um só envio.
  for (const [i, nome] of ["A", "B"].entries()) {
    await page.getByRole("button", { name: "Adicionar seção" }).click();
    await page
      .getByLabel("Título", { exact: true })
      .nth(i + 1)
      .fill(`Seção ${nome}`);
    await page
      .getByLabel("Texto (parágrafos separados por uma linha em branco)")
      .nth(i)
      .fill(`Primeiro de ${nome}.\n\nSegundo de ${nome}.\n\nTerceiro de ${nome}.`);
  }

  // A resposta do servidor demora: durante esse tempo tenta mexer na lista.
  await page.route("**/admin/acervo/fontes/**", async (rota) => {
    if (rota.request().method() === "POST" && rota.request().headers()["next-action"])
      await new Promise((resolver) => setTimeout(resolver, 2500));
    await rota.continue();
  });
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page.getByRole("button", { name: "Salvando…" })).toBeVisible();
  // A lista está congelada: adicionar e remover seção ficam desabilitados enquanto o pedido está no ar.
  await expect(page.getByRole("button", { name: "Adicionar seção" })).toBeDisabled();
  const remover = page.getByRole("button", { name: "Remover esta seção" });
  await expect(remover).toHaveCount(2);
  for (const b of await remover.all()) await expect(b).toBeDisabled();
  // Mesmo forçando o clique na primeira, nada sai da lista.
  await remover
    .first()
    .click({ force: true, trial: false })
    .catch(() => {});
  // O pedido terminou quando o botão volta de "Salvando…" (a faixa "Fonte salva." da criação já estava na página).
  await expect(page.getByRole("button", { name: "Salvando…" })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Salvar Fonte" })).toBeEnabled();
  await expect(page.locator("legend", { hasText: "Seção 1" })).toBeVisible();
  await expect(page.locator("legend", { hasText: "Seção 2" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remover esta seção" })).toHaveCount(0);

  const titulo = (n: number) =>
    lerTexto("select titulo as t from acervo.fonte_secao where id = $1", [`${slug}/secao-${n}`]);
  await expect.poll(() => titulo(1)).toBe("Seção A");
  await expect.poll(() => titulo(2)).toBe("Seção B");

  // Salvar de novo: cada seção cai no próprio endereço (os parágrafos de A não são tocados por B).
  await page
    .getByLabel("Texto (parágrafos separados por uma linha em branco)")
    .nth(1)
    .fill("Só um de B agora.");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect
    .poll(() =>
      lerTexto(
        "select string_agg(texto, '|' order by ordem) as t from acervo.fonte_paragrafo where secao_id = $1",
        [`${slug}/secao-2`],
      ),
    )
    .toBe("Só um de B agora.");
  await expect
    .poll(() =>
      lerTexto(
        "select string_agg(texto, '|' order by ordem) as t from acervo.fonte_paragrafo where secao_id = $1",
        [`${slug}/secao-1`],
      ),
    )
    .toBe("Primeiro de A.|Segundo de A.|Terceiro de A.");
});

test("abrir a edição de uma Fonte com seções, em carga completa da página, não gera aviso de hidratação e os rótulos apontam para os campos", async ({
  page,
}) => {
  await entrarComoAdmin(page, `painel-hidrata-${sufixo}`);
  await abrirFormularioNovo(page);
  const slug = `hidrata-${sufixo}`;
  criadas.push(slug);
  await page.getByLabel("Título", { exact: true }).fill(`Hidrata ${sufixo}`);
  await page.getByLabel("Origem do texto (endereço https)").fill("https://exemplo.invalid/obra");
  await page.getByLabel("Licença (código)").fill("dp-declarado-pela-origem");
  await page.getByRole("button", { name: "Adicionar seção" }).click();
  await page.getByLabel("Título", { exact: true }).nth(1).fill("Seção única");
  await page
    .getByLabel("Texto (parágrafos separados por uma linha em branco)")
    .fill("Um parágrafo.");
  await page.getByRole("button", { name: "Salvar Fonte" }).click();
  await expect(page).toHaveURL(/\?salvo=1/);

  // Carga COMPLETA da página (renderização no servidor e hidratação), com o console vigiado desde o início.
  const avisos = vigiarHidratacao(page);
  await page.goto(`/admin/acervo/fontes/${slug}`);
  await esperarHidratado(page.getByRole("button", { name: "Salvar Fonte" }));
  await expect(page.getByLabel("Texto (parágrafos separados por uma linha em branco)")).toHaveValue(
    "Um parágrafo.",
  );
  const rotulosSemCampo = await page.evaluate(() =>
    [...document.querySelectorAll("label[for]")]
      .map((l) => l.getAttribute("for") as string)
      .filter((id) => !document.getElementById(id)),
  );
  expect(rotulosSemCampo).toEqual([]);
  expect(avisos, "aviso de hidratação").toEqual([]);
});
