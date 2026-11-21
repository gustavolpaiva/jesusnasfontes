import { expect, type Page, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
  lerTexto,
} from "../../support/login-e2e";

// Conflito da Anotação (ANOT-02): duas abas (dois aparelhos) da mesma conta editam o mesmo Estudo. Nada é
// sobrescrito calado: a segunda a salvar vê as duas versões inteiras e escolhe. Roda sobre o conteúdo
// mínimo (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

const ESTUDO = "/estudos/o-nascimento";
const campo = (page: Page) => page.getByRole("textbox", { name: "Minha anotação" });
const estado = (page: Page) => page.locator('[data-slot="save-status"]');
const painel = (page: Page) => page.locator('[data-slot="conflict-panel"]');
const corpoDe = (id: string) =>
  lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]);
const versaoDe = (id: string) =>
  contar("select versao as n from privado.anotacao where estudante_id = $1", [id]);
const chavesDeRascunho = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.localStorage).filter((c) => c.startsWith("jnf:rascunho:")),
  );

// Dois aparelhos: o contexto da conta, e um segundo contexto com a MESMA sessão (outro armazenamento local,
// que é o que um segundo aparelho tem).
async function doisAparelhos(page: Page, browser: import("@playwright/test").Browser) {
  const email = emailDeTeste("conf");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  const id = await idDoUsuario(email);
  const segundo = await browser.newContext({ storageState: await page.context().storageState() });
  const outra = await segundo.newPage();
  await page.goto(ESTUDO);
  await outra.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await esperarHidratado(campo(outra));
  return { id, outra, fechar: () => segundo.close() };
}

test("a aba que salva depois vê as duas versões inteiras; 'Manter a da conta' descarta o rascunho", async ({
  page,
  browser,
}) => {
  const { id, outra, fechar } = await doisAparelhos(page, browser);
  // O outro aparelho escreve primeiro.
  await campo(outra).fill("Texto do outro aparelho, com mais de uma linha.\nSegunda linha.");
  await expect(estado(outra)).toHaveText("Salvo");

  // Esta aba ainda mostra a Anotação vazia e escreve outra coisa: ao salvar, o conflito.
  await campo(page).fill("Texto deste aparelho.");
  await expect(painel(page)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Esta Anotação mudou em outro aparelho" }),
  ).toBeFocused();
  await expect(
    painel(page).getByText(
      "Escolha qual versão manter. A outra será descartada, então copie o que quiser guardar antes.",
    ),
  ).toBeVisible();
  // As duas caixas, com o texto inteiro e a data da versão da conta.
  await expect(painel(page).getByText("Versão salva na sua conta")).toBeVisible();
  await expect(painel(page).getByText("Rascunho deste aparelho")).toBeVisible();
  await expect(
    painel(page).getByText("Texto do outro aparelho, com mais de uma linha."),
  ).toBeVisible();
  await expect(painel(page).getByText("Segunda linha.")).toBeVisible();
  await expect(painel(page).getByText("Texto deste aparelho.")).toBeVisible();
  await expect(
    painel(page)
      .getByText(/^\d{2}\/\d{2}, \d{2}:\d{2}$/)
      .first(),
  ).toBeVisible();
  // Nada foi sobrescrito, e com o painel aberto nenhum envio sai sozinho (nem ao voltar a conexão).
  let enviosDepois = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && (r.postData() ?? "").includes("versaoBase")) enviosDepois += 1;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(800);
  expect(enviosDepois).toBe(0);
  expect(await corpoDe(id)).toBe("Texto do outro aparelho, com mais de uma linha.\nSegunda linha.");
  expect(await versaoDe(id)).toBe(1);
  // Não há botão que junte as duas.
  await expect(painel(page).getByRole("button")).toHaveText([
    "Manter a da conta",
    "Usar o rascunho",
  ]);
  // Os dois textos são selecionáveis (não é campo desabilitado nem `user-select: none`).
  const selecionavel = await painel(page)
    .getByText("Texto deste aparelho.")
    .evaluate((el) => getComputedStyle(el).userSelect);
  expect(selecionavel).not.toBe("none");

  await painel(page).getByRole("button", { name: "Manter a da conta" }).click();
  await expect(painel(page)).toHaveCount(0);
  await expect(campo(page)).toHaveValue(
    "Texto do outro aparelho, com mais de uma linha.\nSegunda linha.",
  );
  expect(await chavesDeRascunho(page)).toHaveLength(0);
  expect(await versaoDe(id)).toBe(1);
  // Depois de manter a da conta, esta aba edita sobre ela, sem conflito.
  await campo(page).fill("Texto do outro aparelho, com mais de uma linha.\nSegunda linha. Mais.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await versaoDe(id)).toBe(2);
  await fechar();
});

test("'Usar o rascunho' grava sobre a versão da conta; o primeiro aparelho vê o conflito na próxima gravação", async ({
  page,
  browser,
}) => {
  const { id, outra, fechar } = await doisAparelhos(page, browser);
  await campo(outra).fill("Versão do aparelho B.");
  await expect(estado(outra)).toHaveText("Salvo");

  await campo(page).fill("Versão do aparelho A.");
  await expect(painel(page)).toBeVisible();
  await painel(page).getByRole("button", { name: "Usar o rascunho" }).click();
  await expect(estado(page)).toHaveText("Salvo");
  await expect(painel(page)).toHaveCount(0);
  expect(await corpoDe(id)).toBe("Versão do aparelho A.");
  expect(await versaoDe(id)).toBe(2);
  expect(await chavesDeRascunho(page)).toHaveLength(0);

  // O aparelho B ainda mostrava a versão dele (base antiga): na próxima gravação, o conflito.
  await campo(outra).fill("Versão do aparelho B, editada.");
  await expect(painel(outra)).toBeVisible();
  await expect(painel(outra).getByText("Versão do aparelho A.")).toBeVisible();
  expect(await corpoDe(id)).toBe("Versão do aparelho A.");
  await fechar();
});

test("Anotação apagada no outro aparelho: escrever aqui mostra a conta vazia e não a ressuscita calado", async ({
  page,
  browser,
}) => {
  const { id, outra, fechar } = await doisAparelhos(page, browser);
  await campo(page).fill("Vai ser apagada lá.");
  await expect(estado(page)).toHaveText("Salvo");
  await outra.reload();
  await esperarHidratado(campo(outra));
  await expect(campo(outra)).toHaveValue("Vai ser apagada lá.");
  await campo(outra).fill("");
  await expect(estado(outra)).toHaveText("Salvo");
  expect(
    await contar(
      "select count(*) as n from privado.anotacao where estudante_id = $1 and corpo <> ''",
      [id],
    ),
  ).toBe(0);

  await campo(page).fill("Vai ser apagada lá. E eu acrescentei.");
  await expect(painel(page)).toBeVisible();
  await expect(painel(page).getByText("(Anotação apagada)")).toBeVisible();
  expect(
    await contar(
      "select count(*) as n from privado.anotacao where estudante_id = $1 and corpo <> ''",
      [id],
    ),
  ).toBe(0);
  await fechar();
});

test("o rascunho de um aparelho velho, aberto depois de a conta andar, vira conflito ao abrir (não é enviado calado)", async ({
  page,
  browser,
}) => {
  const { id, outra, fechar } = await doisAparelhos(page, browser);
  // Este aparelho escreve e o envio é cortado: fica só o rascunho local, sobre a base "nenhuma".
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      await rota.abort("connectionfailed");
    } else await rota.continue();
  });
  await campo(page).fill("Rascunho do aparelho velho.");
  await expect(estado(page)).toContainText("Não foi possível salvar");
  // O outro aparelho grava uma versão.
  await campo(outra).fill("Versão que chegou enquanto isso.");
  await expect(estado(outra)).toHaveText("Salvo");
  // Abrir de novo, com o servidor acessível: as duas versões, sem envio calado.
  await page.unroute("**/*");
  await page.reload();
  await expect(painel(page)).toBeVisible();
  await expect(painel(page).getByText("Rascunho do aparelho velho.")).toBeVisible();
  await expect(painel(page).getByText("Versão que chegou enquanto isso.")).toBeVisible();
  expect(await corpoDe(id)).toBe("Versão que chegou enquanto isso.");
  await fechar();
});

test("com o conflito aberto o rascunho fica, mesmo com o campo igual à base antiga: recarregar antes da escolha não perde a versão local (revisão, rodada 11)", async ({
  page,
  browser,
}) => {
  const { id, outra, fechar } = await doisAparelhos(page, browser);
  await campo(page).fill("T0 desta aba.");
  await expect(estado(page)).toHaveText("Salvo");
  await outra.reload();
  await esperarHidratado(campo(outra));
  await expect(campo(outra)).toHaveValue("T0 desta aba.");

  // O próximo envio desta aba fica seguro a caminho.
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      await portao;
    }
    await rota.continue();
  });
  await campo(page).fill("T1 desta aba.");
  await expect(estado(page)).toHaveText("Salvando…");
  // O campo volta ao T0 (igual à base que esta aba conhecia) enquanto o outro aparelho grava o T2.
  await campo(page).fill("T0 desta aba.");
  await campo(outra).fill("T2 do outro aparelho.");
  await expect(estado(outra)).toHaveText("Salvo");
  liberar();
  await expect(painel(page)).toBeVisible();
  // O conflito está aberto: o rascunho fica até a escolha.
  expect(await chavesDeRascunho(page)).toHaveLength(1);

  await page.unroute("**/*");
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(painel(page)).toBeVisible();
  await expect(painel(page).getByText("T0 desta aba.")).toBeVisible();
  await expect(painel(page).getByText("T2 do outro aparelho.")).toBeVisible();
  expect(await corpoDe(id)).toBe("T2 do outro aparelho.");
  await fechar();
});
