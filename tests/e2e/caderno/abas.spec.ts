import { randomUUID } from "node:crypto";
import { expect, type Page, type Route, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
  lerTexto,
} from "../../support/login-e2e";

// Revisão do Codex, rodada 2 (P1, perda de texto): duas abas do mesmo navegador no MESMO Estudo dividem o
// `localStorage`. O rascunho de cada aba tem de ser da aba: a confirmação de um envio numa aba nunca apaga,
// nem sobrescreve, o texto ainda pendente de outra. Roda sobre o conteúdo mínimo
// (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

const ESTUDO = "/estudos/o-nascimento";
const campo = (p: Page) => p.getByRole("textbox", { name: "Minha anotação" });
const estado = (p: Page) => p.locator('[data-slot="save-status"]');
const painel = (p: Page) => p.locator('[data-slot="conflict-panel"]');
const chaves = (p: Page) =>
  p.evaluate(() => Object.keys(window.localStorage).filter((c) => c.startsWith("jnf:rascunho:")));

async function entrar(page: Page): Promise<string> {
  const email = emailDeTeste("abas");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return idDoUsuario(email);
}

async function cortarEnvio(page: Page): Promise<() => Promise<void>> {
  const tratador = async (rota: Route) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      await rota.abort("connectionfailed");
    } else await rota.continue();
  };
  await page.route("**/*", tratador);
  return () => page.unroute("**/*", tratador);
}

async function abrir(contexto: import("@playwright/test").BrowserContext): Promise<Page> {
  const p = await contexto.newPage();
  await p.goto(ESTUDO);
  await esperarHidratado(campo(p));
  return p;
}

test("a confirmação de um envio numa aba não apaga o texto pendente de outra aba do mesmo Estudo", async ({
  page,
  context,
}) => {
  const id = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const b = await abrir(context);
  await cortarEnvio(b);
  const pendente = `PENDENTE-DE-B-${randomUUID()}`;
  await campo(b).fill(pendente);
  await expect(estado(b)).toContainText("Não foi possível salvar");

  // A aba A salva (e a confirmação dela limpa o rascunho DELA).
  await campo(page).fill("Texto salvo pela aba A.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe("Texto salvo pela aba A.");

  // A aba B é recarregada (o envio dela continua cortado): o texto pendente não se perdeu. Como a Anotação
  // do servidor andou, ele volta como as DUAS versões lado a lado, nunca enviado calado.
  await b.reload();
  await esperarHidratado(campo(b));
  await expect(painel(b)).toBeVisible();
  await expect(painel(b).getByText(pendente)).toBeVisible();
  await expect(painel(b).getByText("Texto salvo pela aba A.")).toBeVisible();
  expect(
    await contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(1);
});

test("o rascunho de uma aba fechada volta na aba nova, e quando há mais de um o mais recente vem primeiro e os outros ficam guardados", async ({
  page,
  context,
}) => {
  const id = await entrar(page);
  await page.close();
  // Duas abas com texto pendente (servidor vazio), uma depois da outra, e as duas fechadas.
  const antigo = `ANTIGO-${randomUUID()}`;
  const novo = `NOVO-${randomUUID()}`;
  for (const texto of [antigo, novo]) {
    const p = await abrir(context);
    await cortarEnvio(p);
    await campo(p).fill(texto);
    await expect(estado(p)).toContainText("Não foi possível salvar");
    await p.waitForTimeout(30);
    await p.close();
  }
  const d = await abrir(context);
  // Os dois rascunhos das abas fechadas, mais a cópia que a aba nova guarda do que recuperou.
  expect(await chaves(d)).toHaveLength(3);
  // A aba nova recupera o MAIS RECENTE e o envia; o outro continua guardado.
  await expect(campo(d)).toHaveValue(novo);
  await expect(estado(d)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(novo);
  expect(await chaves(d)).toHaveLength(1);
  await d.close();

  // Na abertura seguinte o que sobrou (escrito antes da versão que está no servidor) vem como conflito.
  const e = await abrir(context);
  await expect(painel(e)).toBeVisible();
  await expect(painel(e).getByText(antigo)).toBeVisible();
  await expect(painel(e).getByText(novo)).toBeVisible();
  await painel(e).getByRole("button", { name: "Manter a da conta" }).click();
  await expect(painel(e)).toHaveCount(0);
  expect(await chaves(e)).toHaveLength(0);
});
