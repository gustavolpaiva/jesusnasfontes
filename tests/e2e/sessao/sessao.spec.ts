import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
  lerTexto,
} from "../../support/login-e2e";

// Sessão (TRIL-03): check-in no Estudo, faixa aberta, check-out com a Anotação da Sessão, histórico nas
// Trilhas, estados e erros. Roda sobre o conteúdo mínimo de teste (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

async function entrar(page: Page, prefixo = "sess"): Promise<{ email: string; id: string }> {
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return { email, id: await idDoUsuario(email) };
}

// O clique antes da hidratação não faz nada (o botão ainda não tem o tratador do React): espera o React
// ligar o botão antes de clicar, em vez de contar com a sorte do tempo.
async function clicarQuandoHidratado(page: Page, nome: string | RegExp): Promise<void> {
  const botao = page.getByRole("button", { name: nome });
  await botao.waitFor();
  await botao.evaluate(
    (el) =>
      new Promise<void>((pronto) => {
        const ligado = () => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
        const olhar = () => (ligado() ? pronto() : setTimeout(olhar, 25));
        olhar();
      }),
  );
  await botao.click();
}

const faixa = (page: Page) => page.locator('[data-slot="sessao-bar"]');
const folha = (page: Page) => page.getByRole("dialog", { name: "Encerrar a Sessão" });
const sessoesDe = (id: string) =>
  contar("select count(*) as n from privado.sessao where estudante_id = $1", [id]);
const encerradasDe = (id: string) =>
  contar(
    "select count(*) as n from privado.sessao where estudante_id = $1 and check_out_em is not null",
    [id],
  );

test("check-in num Estudo, navegar para outro, check-out com Anotação, mensagem com 'de A até B' e a linha no histórico", async ({
  page,
}) => {
  const { id } = await entrar(page);

  // Sem Sessão: rótulo, frase do contrato e o botão com o Estudo no nome acessível.
  await page.goto("/estudos/o-nascimento");
  await expect(faixa(page).getByText("Nenhuma Sessão aberta.")).toBeVisible();
  await clicarQuandoHidratado(page, "Fazer check-in no Estudo: O nascimento");
  await expect(
    faixa(page).getByText(/^Sessão aberta desde \d{2}:\d{2}, em O nascimento\.$/),
  ).toBeVisible();
  expect(await sessoesDe(id)).toBe(1);

  // Em outro Estudo a Sessão segue aberta, com o Estudo de início.
  await page.goto("/estudos/batismo-e-tentacao");
  await expect(faixa(page).getByText(/em O nascimento\./)).toBeVisible();
  await clicarQuandoHidratado(page, "Fazer check-out");
  await expect(folha(page)).toBeVisible();
  await expect(folha(page).getByText("Ela é privada, como as suas Anotações.")).toBeVisible();
  const campo = folha(page).getByLabel("Anotação da Sessão (opcional)");
  await expect(folha(page).getByText("0 de 200 caracteres")).toBeVisible();
  await campo.fill("Li a tentação com calma.");
  await expect(folha(page).getByText("24 de 200 caracteres")).toBeVisible();
  await folha(page).getByRole("button", { name: "Encerrar Sessão" }).click();

  // Mensagem em linha, `role="status"`, com o Estudo de início e o de fim.
  const sucesso = page.getByRole("status").filter({ hasText: "Feito." });
  await expect(sucesso).toContainText(
    /Sessão encerrada: \d+ min, de O nascimento até Batismo e tentação\./,
  );
  await expect(folha(page)).toHaveCount(0);
  await expect(faixa(page).getByRole("button", { name: /Fazer check-in/ })).toBeVisible();
  expect(await encerradasDe(id)).toBe(1);

  // O histórico nas Trilhas: a linha, e a Anotação da Sessão em itálico.
  await page.goto("/trilhas");
  const historico = page.getByRole("region", { name: "Sessões" });
  await expect(historico.getByRole("heading", { level: 2, name: "Sessões" })).toBeVisible();
  const linha = historico.getByRole("listitem").first();
  await expect(linha).toContainText(
    /\d{2}\/\d{2}, \d{2}:\d{2} · \d+ min · de O nascimento até Batismo e tentação/,
  );
  const nota = linha.getByText("Li a tentação com calma.");
  await expect(nota).toBeVisible();
  await expect(nota).toHaveCSS("font-style", "italic");
  // Com a Sessão encerrada, a faixa das Trilhas mostra a última.
  await expect(
    faixa(page).getByText(/^Última Sessão: \d{2}\/\d{2}, \d{2}:\d{2} a \d{2}:\d{2} \(\d+ min\)\.$/),
  ).toBeVisible();
});

test("o histórico vazio mostra o estado do contrato e a faixa diz que não há Sessão", async ({
  page,
}) => {
  await entrar(page);
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { name: "Nenhuma Sessão ainda" })).toBeVisible();
  await expect(
    page.getByText("Faça check-in em um Estudo para começar a registrar suas Sessões."),
  ).toBeVisible();
  await expect(faixa(page).getByText("Nenhuma Sessão aberta.")).toBeVisible();
});

test("check-in nas Trilhas abre no Estudo mais recente da pessoa; sem posição, no primeiro", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto("/trilhas");
  await clicarQuandoHidratado(page, "Fazer check-in");
  await expect(
    faixa(page).getByText(/^Sessão aberta desde \d{2}:\d{2}, em Como sabemos o que sabemos\.$/),
  ).toBeVisible();
  expect(await sessoesDe(id)).toBe(1);
});

test("duas abas: o check-out da segunda acha a Sessão já encerrada, avisa e mantém o texto", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto("/estudos/o-nascimento");
  await clicarQuandoHidratado(page, "Fazer check-in no Estudo: O nascimento");
  await expect(faixa(page).getByText(/em O nascimento\./)).toBeVisible();
  await clicarQuandoHidratado(page, "Fazer check-out");
  await folha(page).getByLabel("Anotação da Sessão (opcional)").fill("da segunda aba");

  // Outra aba (a mesma sessão) encerra primeiro.
  const outra = await page.context().newPage();
  await outra.goto("/estudos/o-nascimento");
  await clicarQuandoHidratado(outra, "Fazer check-out");
  await outra.getByLabel("Anotação da Sessão (opcional)").fill("da primeira aba");
  await outra.getByRole("button", { name: "Encerrar Sessão" }).click();
  await expect(outra.getByRole("status").filter({ hasText: "Feito." })).toBeVisible();
  await outra.close();

  await folha(page).getByRole("button", { name: "Encerrar Sessão" }).click();
  await expect(folha(page).getByRole("status")).toContainText(
    "Esta Sessão já foi encerrada em outra aba.",
  );
  await expect(folha(page).getByLabel("Anotação da Sessão (opcional)")).toHaveValue(
    "da segunda aba",
  );
  // Uma linha, com o texto da primeira.
  expect(await sessoesDe(id)).toBe(1);
  expect(
    await lerTexto("select anotacao as t from privado.sessao where estudante_id = $1", [id]),
  ).toBe("da primeira aba");
});

test("sem conexão: check-in e check-out mostram o erro de conexão, nada entra em fila e o texto digitado fica", async ({
  page,
  context,
}) => {
  const { id } = await entrar(page);
  await page.goto("/estudos/o-nascimento");
  await expect(faixa(page).getByText("Nenhuma Sessão aberta.")).toBeVisible();
  await clicarQuandoHidratado(page, "Fazer check-in no Estudo: O nascimento");
  await expect(faixa(page).getByText(/em O nascimento\./)).toBeVisible();
  expect(await sessoesDe(id)).toBe(1);

  // Check-out sem conexão: a folha mostra o erro e o texto continua no campo.
  await clicarQuandoHidratado(page, "Fazer check-out");
  const campo = folha(page).getByLabel("Anotação da Sessão (opcional)");
  await campo.fill("não pode se perder");
  await context.setOffline(true);
  await folha(page).getByRole("button", { name: "Encerrar Sessão" }).click();
  await expect(folha(page).getByRole("alert")).toContainText(
    "Sem conexão. Tente de novo quando a conexão voltar.",
  );
  await expect(campo).toHaveValue("não pode se perder");
  expect(await encerradasDe(id)).toBe(0);

  // Voltou a conexão: nada ficou em fila; só uma nova tentativa grava.
  await context.setOffline(false);
  await page.waitForTimeout(1500);
  expect(await encerradasDe(id)).toBe(0);
  await folha(page).getByRole("button", { name: "Encerrar Sessão" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Feito." })).toBeVisible();
  expect(await encerradasDe(id)).toBe(1);
  expect(
    await lerTexto("select anotacao as t from privado.sessao where estudante_id = $1", [id]),
  ).toBe("não pode se perder");
});

test("sem conexão no check-in: o erro de conexão aparece e nenhuma Sessão é criada", async ({
  page,
  context,
}) => {
  const { id } = await entrar(page);
  await page.goto("/estudos/o-nascimento");
  await expect(faixa(page).getByText("Nenhuma Sessão aberta.")).toBeVisible();
  const botao = page.getByRole("button", { name: "Fazer check-in no Estudo: O nascimento" });
  await botao.waitFor();
  await botao.evaluate(
    (el) =>
      new Promise<void>((pronto) => {
        const olhar = () =>
          Object.keys(el).some((k) => k.startsWith("__reactProps$"))
            ? pronto()
            : setTimeout(olhar, 25);
        olhar();
      }),
  );
  await context.setOffline(true);
  await botao.click();
  await expect(page.getByRole("alert").filter({ hasText: "Sem conexão." })).toContainText(
    "Sem conexão. Tente de novo quando a conexão voltar.",
  );
  expect(await sessoesDe(id)).toBe(0);
  await context.setOffline(false);
  await page.waitForTimeout(1500);
  expect(await sessoesDe(id)).toBe(0);
});

test("Sessão aberta ontem mostra a data junto da hora", async ({ page }) => {
  const { id } = await entrar(page);
  const ontem = new Date(Date.now() - 24 * 3_600_000);
  await escrever(
    `insert into privado.sessao (estudante_id, check_in_em, estudo_inicio_id)
     select $1, $2::timestamptz, id from conteudo.estudo where slug = 'o-nascimento'`,
    [id, ontem.toISOString()],
  );
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "America/Sao_Paulo",
    })
      .formatToParts(ontem)
      .map((p) => [p.type, p.value]),
  );
  const esperado = `${partes.day}/${partes.month}, ${partes.hour}:${partes.minute}`;
  await page.goto("/trilhas");
  await expect(faixa(page)).toContainText(`Sessão aberta desde ${esperado}, em O nascimento.`);
});

test("erro de check-in: o Estudo sumiu entre abrir a tela e clicar; a copy do contrato, e nada é gravado", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await comEstudoTemporario("Estudo que some", async (slug) => {
    await page.goto(`/estudos/${slug}`);
    const botao = page.getByRole("button", { name: "Fazer check-in no Estudo: Estudo que some" });
    await botao.waitFor();
    await botao.evaluate(
      (el) =>
        new Promise<void>((pronto) => {
          const olhar = () =>
            Object.keys(el).some((k) => k.startsWith("__reactProps$"))
              ? pronto()
              : setTimeout(olhar, 25);
          olhar();
        }),
    );
  });
  await page.getByRole("button", { name: /Fazer check-in/ }).click();
  const erro = faixa(page).getByRole("alert");
  await expect(erro).toContainText("Erro.");
  await expect(erro).toContainText("Não conseguimos registrar o check-in. Tente de novo.");
  expect(await sessoesDe(id)).toBe(0);
});

test("a Anotação acima de 200 caracteres (campo adulterado) é recusada no servidor e o texto continua", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto("/estudos/o-nascimento");
  await clicarQuandoHidratado(page, "Fazer check-in no Estudo: O nascimento");
  await expect(faixa(page).getByText(/em O nascimento\./)).toBeVisible();
  await clicarQuandoHidratado(page, "Fazer check-out");
  const campo = folha(page).getByLabel("Anotação da Sessão (opcional)");
  // O limite do campo é do navegador; o servidor confere de novo. Tira o limite e escreve 201.
  await campo.evaluate((el) => el.removeAttribute("maxlength"));
  await campo.fill("x".repeat(201));
  await folha(page).getByRole("button", { name: "Encerrar Sessão" }).click();
  await expect(folha(page).getByRole("alert")).toContainText("tem no máximo 200 caracteres");
  await expect(campo).toHaveValue("x".repeat(201));
  expect(await encerradasDe(id)).toBe(0);
});

test("o campo limita a 200 caracteres e a contagem acompanha", async ({ page }) => {
  await entrar(page);
  await page.goto("/estudos/o-nascimento");
  await clicarQuandoHidratado(page, "Fazer check-in no Estudo: O nascimento");
  await expect(faixa(page).getByText(/em O nascimento\./)).toBeVisible();
  await clicarQuandoHidratado(page, "Fazer check-out");
  const campo = folha(page).getByLabel("Anotação da Sessão (opcional)");
  await campo.pressSequentially("y".repeat(210), { delay: 0 });
  await expect(folha(page).getByText("200 de 200 caracteres")).toBeVisible();
  await expect(campo).toHaveValue("y".repeat(200));
});

test("a folha: axe sem violações, Esc fecha e devolve o foco ao botão, Voltar fecha sem encerrar", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto("/estudos/o-nascimento");
  await clicarQuandoHidratado(page, "Fazer check-in no Estudo: O nascimento");
  await expect(faixa(page).getByText(/em O nascimento\./)).toBeVisible();
  await expect(faixa(page)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await clicarQuandoHidratado(page, "Fazer check-out");
  await expect(folha(page)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(folha(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Fazer check-out" })).toBeFocused();

  await clicarQuandoHidratado(page, "Fazer check-out");
  await folha(page).getByRole("button", { name: "Voltar" }).click();
  await expect(folha(page)).toHaveCount(0);
  expect(await encerradasDe(id)).toBe(0);
  // O histórico vazio também passa no axe.
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { name: "Sessões" })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

// Estudo criado só para o teste, em uma Trilha própria e removido no fim (com a Trilha): não muda o
// "estudo 3 de 3" nem as contagens dos outros testes que rodam ao mesmo tempo no mesmo banco. `ordem` é
// única entre as Trilhas e os projetos de varredura rodam juntos, por isso sai ao acaso.
async function comEstudoTemporario(
  titulo: string,
  fn: (slug: string) => Promise<void>,
): Promise<void> {
  const id = randomUUID().slice(0, 8);
  const trilha = `trilha-temp-${id}`;
  const slug = `estudo-temp-${id}`;
  const ordem = String(1000 + Math.floor(Math.random() * 30000));
  await escrever(
    "insert into conteudo.trilha (id, nome, ordem, descricao) values ($1, 'Trilha de teste', $2, 'x')",
    [trilha, ordem],
  );
  await escrever(
    `insert into conteudo.estudo (slug, trilha_id, ordem, titulo, recorte, corpo_md, conteudo_hash)
     values ($1, $2, 1, $3, 'devocional', 'x', repeat('a', 64))`,
    [slug, trilha, titulo],
  );
  try {
    await fn(slug);
  } finally {
    await escrever("delete from conteudo.estudo where slug = $1", [slug]);
    await escrever("delete from conteudo.trilha where id = $1", [trilha]);
  }
}

const TITULO_LONGO =
  "A travessia noturna do lago, a tempestade que calou os discípulos e o chamado para seguir o Mestre até a outra margem";

async function conferirTituloLongo(page: Page, passo5: boolean): Promise<void> {
  const { id } = await entrar(page, "longo");
  await comEstudoTemporario(TITULO_LONGO, async (slug) => {
    await escrever(
      `insert into privado.sessao (estudante_id, estudo_inicio_id)
       select $1, id from conteudo.estudo where slug = $2`,
      [id, slug],
    );
    await page.goto(`/estudos/${slug}`);
    await expect(faixa(page)).toContainText(`em ${TITULO_LONGO}.`);
    const frase = faixa(page).locator("p");
    const botao = faixa(page).getByRole("button", { name: "Fazer check-out" });
    await expect(botao).toBeVisible();
    const sobra = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // Quem passa da borda direita, para a falha dizer qual elemento (e não só quantos pixels).
    const passam = await page.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter(
          (el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 0.5,
        )
        .slice(0, 5)
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String(el.className).slice(0, 60)}`,
        ),
    );
    expect(sobra, `rolagem horizontal; passam da borda: ${passam.join(" | ")}`).toBeLessThanOrEqual(
      0,
    );
    const f = await frase.boundingBox();
    const b = await botao.boundingBox();
    expect(f && b).toBeTruthy();
    if (!f || !b) return;
    // O texto quebra em várias linhas, nada é cortado e o botão desce para a linha seguinte.
    expect(f.height).toBeGreaterThan(40);
    expect(b.y).toBeGreaterThanOrEqual(f.y + f.height - 1);
    const viewport = page.viewportSize();
    expect(b.x + b.width).toBeLessThanOrEqual((viewport?.width ?? 0) + 1);
    // O botão continua à vista sem rolar no começo da página (a faixa é a primeira coisa do conteúdo).
    if (!passo5) expect(b.y + b.height).toBeLessThanOrEqual(viewport?.height ?? 0);
  });
}

test("nome de Estudo longo na faixa: a frase quebra, nada é cortado e o botão desce, sem rolagem horizontal", async ({
  page,
}) => {
  await conferirTituloLongo(page, false);
});

test("@varredura passo 5: nome de Estudo longo na faixa, sem rolagem horizontal", async ({
  page,
  baseURL,
}) => {
  await page
    .context()
    .addCookies([{ name: "escala-texto", value: "5", url: baseURL ?? "http://localhost" }]);
  await conferirTituloLongo(page, true);
});
