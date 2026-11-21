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

test("duplicar a aba (o sessionStorage é copiado) não faz duas abas dividirem a chave: cada uma guarda o seu texto e a confirmação de uma não apaga o da outra", async ({
  page,
  context,
}) => {
  await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  // Uma aba duplicada nasce com o sessionStorage da original: simulado copiando tudo o que a original tem.
  const copia = await page.evaluate(() => JSON.stringify({ ...window.sessionStorage }));
  const duplicada = await context.newPage();
  await duplicada.addInitScript((dados) => {
    for (const [k, v] of Object.entries(JSON.parse(dados) as Record<string, string>)) {
      window.sessionStorage.setItem(k, v);
    }
  }, copia);
  await duplicada.goto(ESTUDO);
  await esperarHidratado(campo(duplicada));

  const religarA = await cortarEnvio(page);
  const religarB = await cortarEnvio(duplicada);
  const deA = `TEXTO-DA-ORIGINAL-${randomUUID()}`;
  const deB = `TEXTO-DA-DUPLICADA-${randomUUID()}`;
  await campo(page).fill(deA);
  await expect(estado(page)).toContainText("Não foi possível salvar");
  await campo(duplicada).fill(deB);
  await expect(estado(duplicada)).toContainText("Não foi possível salvar");
  // Duas abas, dois rascunhos.
  expect(await chaves(page)).toHaveLength(2);

  // A original envia e é confirmada: o rascunho da duplicada continua lá.
  await religarA();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(estado(page)).toHaveText("Salvo");
  const restantes = await page.evaluate(() =>
    Object.keys(window.localStorage)
      .filter((c) => c.startsWith("jnf:rascunho:"))
      .map((c) => JSON.parse(window.localStorage.getItem(c) ?? "{}").corpo as string),
  );
  expect(restantes).toEqual([deB]);
  await religarB();
});

test("a aba que adota o rascunho de outra e o confirma não apaga o que a dona original escreveu depois", async ({
  page,
  context,
}) => {
  const id = await entrar(page);
  await page.close();
  const b = await abrir(context);
  await cortarEnvio(b);
  const v1 = `V1-${randomUUID()}`;
  const v2 = `V2-${randomUUID()}`;
  await campo(b).fill(v1);
  await expect(estado(b)).toContainText("Não foi possível salvar");

  // A aba A abre, adota o v1 de B e o envia; o envio fica SEGURO a caminho enquanto B escreve o v2.
  const a = await context.newPage();
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  await a.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase"))
      await portao;
    await rota.continue();
  });
  await a.goto(ESTUDO);
  await expect(campo(a)).toHaveValue(v1);
  await expect(estado(a)).toHaveText("Salvando…");
  await campo(b).fill(v2);
  await expect(estado(b)).toContainText("Não foi possível salvar");
  liberar();
  await expect(estado(a)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(v1);

  // O v2, ainda não enviado, não se perdeu: ao recarregar B ele volta (o servidor tem o v1, então como conflito).
  await b.reload();
  await esperarHidratado(campo(b));
  await expect(painel(b)).toBeVisible();
  await expect(painel(b).getByText(v2)).toBeVisible();
});

test("a resposta de um envio que chega depois de o editor sair da tela não mexe no rascunho do editor novo do mesmo Estudo", async ({
  page,
}) => {
  const id = await entrar(page);
  const estudo = "/estudos/batismo-e-tentacao";
  // O PRIMEIRO envio fica seguro a caminho (resposta controlada); todos os seguintes são cortados, então o
  // texto novo só existe no rascunho do aparelho.
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await portao;
        await rota.continue();
      } else await rota.abort("connectionfailed");
    } else await rota.continue();
  });
  await page.goto(estudo);
  await esperarHidratado(campo(page));
  const t1 = `T1-${randomUUID()}`;
  const t2 = `T2-${randomUUID()}`;
  const t3 = `T3-${randomUUID()}`;
  await campo(page).fill(t1);
  await expect(estado(page)).toHaveText("Salvando…");
  await campo(page).fill(t2);

  // Navega para outro Estudo (sem recarregar a página) e volta: o editor do primeiro Estudo é outro.
  await page.getByRole("link", { name: "Anterior" }).click();
  await expect(page).toHaveURL(/\/estudos\/o-nascimento$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/estudos\/batismo-e-tentacao$/);
  await esperarHidratado(campo(page));
  await campo(page).fill(t3);
  await expect(estado(page)).toContainText("Não foi possível salvar");

  // A resposta do envio antigo chega AGORA, ao editor que já não existe.
  liberar();
  await page.waitForTimeout(1500);
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(t1);

  // Recarregar antes do próximo envio: o T3 não se perdeu (o servidor tem o T1, então vem como conflito).
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(painel(page)).toBeVisible();
  await expect(painel(page).getByText(t3)).toBeVisible();
});

test("digitar e apagar tudo antes de 1,5 s num Estudo sem Anotação não deixa rascunho: ao recarregar nada volta nem é enviado", async ({
  page,
}) => {
  const id = await entrar(page);
  const envios: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && (r.postData() ?? "").includes("versaoBase")) envios.push(r.url());
  });
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill(`TEXTO-APAGADO-${randomUUID()}`);
  // O campo volta a ser igual ao servidor (vazio, sem Anotação) antes de o envio de 1,5 s acontecer.
  await campo(page).fill("");
  expect(await chaves(page)).toEqual([]);

  await page.reload();
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
  await expect(estado(page)).toHaveText("");
  // Espera mais que o tempo do envio automático: nada pode ter ido ao servidor, e nada foi criado.
  await page.waitForTimeout(2200);
  expect(envios).toEqual([]);
  expect(
    await contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(0);
  expect(await chaves(page)).toEqual([]);
});
