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

// Os cenários das nove rodadas da revisão do Codex sobre o editor da Anotação (perda e vazamento de texto entre
// abas, entre montagens e com resposta perdida). Desde a rodada 10 o modelo é: cada montagem do editor é um
// escritor (id e número de envio), o servidor ordena os envios, e o rascunho tem um dono só, que segura a trava
// do escritor; quem retoma um escritor que sumiu continua do número seguinte. Roda sobre o conteúdo mínimo
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
// A Anotação apagada guarda a linha com o corpo vazio (0014): conta só a que tem texto.
const comTextoDe = (id: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1 and corpo <> ''", [
    id,
  ]);

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
  const religarB = await cortarEnvio(b);
  const pendente = `PENDENTE-DE-B-${randomUUID()}`;
  await campo(b).fill(pendente);
  await expect(estado(b)).toContainText("Não foi possível salvar");

  // A aba A salva (e a confirmação dela limpa o rascunho DELA).
  await campo(page).fill("Texto salvo pela aba A.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe("Texto salvo pela aba A.");

  // A aba B é recarregada (o envio dela continua cortado): o texto pendente não se perdeu, volta no campo.
  await b.reload();
  await esperarHidratado(campo(b));
  await expect(campo(b)).toHaveValue(pendente);
  await expect(estado(b)).toContainText("Não foi possível salvar");
  // Quando o envio passa, o servidor (que andou) responde com as DUAS versões lado a lado: nada é sobrescrito.
  await religarB();
  await b.evaluate(() => window.dispatchEvent(new Event("online")));
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
  // Duas abas abertas ao mesmo tempo (cada uma é o seu escritor), com texto pendente (servidor vazio), uma
  // escrita depois da outra, e as duas fechadas.
  const antigo = `ANTIGO-${randomUUID()}`;
  const novo = `NOVO-${randomUUID()}`;
  const abas = [await abrir(context), await abrir(context)];
  for (const [i, texto] of [antigo, novo].entries()) {
    const p = abas[i] as Page;
    await cortarEnvio(p);
    await campo(p).fill(texto);
    await expect(estado(p)).toContainText("Não foi possível salvar");
    await p.waitForTimeout(30);
  }
  for (const p of abas) await p.close();
  const d = await abrir(context);
  // A aba nova RETOMA o escritor mais recente (o mesmo rascunho, sem cópia) e o envia; o outro fica guardado.
  await expect(campo(d)).toHaveValue(novo);
  await expect(estado(d)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(novo);
  expect(await chaves(d)).toHaveLength(1);
  await d.close();

  // Na abertura seguinte o que sobrou (escrito sem ver a versão que está no servidor) vem como conflito.
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

test("uma aba aberta nunca retoma o rascunho de outra aba ainda viva: o que a dona escreve depois não se perde", async ({
  page,
  context,
}) => {
  const id = await entrar(page);
  await page.close();
  const b = await abrir(context);
  const religarB = await cortarEnvio(b);
  const v1 = `V1-${randomUUID()}`;
  const v2 = `V2-${randomUUID()}`;
  await campo(b).fill(v1);
  await expect(estado(b)).toContainText("Não foi possível salvar");

  // A aba A abre com B viva: não retoma o v1 (a trava do escritor de B está segura), não envia nada dele.
  const envios: string[] = [];
  const a = await context.newPage();
  a.on("request", (r) => {
    if (r.method() === "POST" && (r.postData() ?? "").includes("versaoBase"))
      envios.push(r.postData() ?? "");
  });
  await a.goto(ESTUDO);
  await esperarHidratado(campo(a));
  await a.waitForTimeout(2200);
  await expect(campo(a)).toHaveValue("");
  expect(envios).toEqual([]);
  // B escreve o v2; A escreve e salva o dela.
  await campo(b).fill(v2);
  await expect(estado(b)).toContainText("Não foi possível salvar");
  await campo(a).fill("Texto da aba A.");
  await expect(estado(a)).toHaveText("Salvo");
  expect(envios.some((e) => e.includes(v1) || e.includes(v2))).toBe(false);
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe("Texto da aba A.");

  // O v2, ainda não enviado, não se perdeu: ao recarregar B ela retoma o próprio escritor e o envia; o
  // servidor tem o texto de A, então vem como conflito, com as duas versões.
  await b.reload();
  await esperarHidratado(campo(b));
  await expect(campo(b)).toHaveValue(v2);
  await religarB();
  await b.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(painel(b)).toBeVisible();
  await expect(painel(b).getByText(v2)).toBeVisible();
  await expect(painel(b).getByText("Texto da aba A.")).toBeVisible();
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
  const tratador = async (rota: Route) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await portao;
        await rota.continue();
      } else await rota.abort("connectionfailed");
    } else await rota.continue();
  };
  await page.route("**/*", tratador);
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

  // Recarregar antes do próximo envio: o T3 não se perdeu. O T1, o T2 e o T3 são do MESMO escritor (o editor
  // da volta o retomou), então o T3 continua o T1 no servidor: sem conflito, e o servidor termina com o T3.
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue(t3);
  await page.unroute("**/*", tratador);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(estado(page)).toHaveText("Salvo");
  await expect(painel(page)).toHaveCount(0);
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(t3);
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

// ───────────── envio pendente: a última edição nunca se perde, nem a de apagar ─────────────

// Segura o PRIMEIRO envio da Anotação até `liberar()`; os seguintes passam.
async function segurarPrimeiroEnvio(page: Page): Promise<() => void> {
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) await portao;
    }
    await rota.continue();
  });
  return liberar;
}

test("apagar tudo durante um envio e navegar antes da resposta não perde a exclusão: ao voltar com o servidor já com o texto, o apagar é enviado", async ({
  page,
}) => {
  const id = await entrar(page);
  const liberar = await segurarPrimeiroEnvio(page);
  await page.goto("/estudos/batismo-e-tentacao");
  await esperarHidratado(campo(page));
  const x = `X-${randomUUID()}`;
  await campo(page).fill(x);
  await expect(estado(page)).toHaveText("Salvando…");
  // Durante o envio o campo volta a ser igual à base antiga (vazio, sem Anotação): o rascunho NÃO pode sair.
  await campo(page).fill("");
  expect(await chaves(page)).toHaveLength(1);

  await page.getByRole("link", { name: "Anterior" }).click();
  await expect(page).toHaveURL(/\/estudos\/o-nascimento$/);
  liberar();
  await expect
    .poll(() =>
      lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]).catch(
        () => "",
      ),
    )
    .toBe(x);
  await page.goBack();
  await expect(page).toHaveURL(/\/estudos\/batismo-e-tentacao$/);
  await esperarHidratado(campo(page));
  // O servidor mostra o efeito do envio (tem o texto): a edição guardada, apagar tudo, é enviada.
  await expect(estado(page)).toHaveText("Salvo");
  await expect(campo(page)).toHaveValue("");
  expect(await comTextoDe(id)).toBe(0);
});

test("sair e voltar ANTES de o envio chegar: a exclusão vai primeiro e o envio velho, quando chega, é recusado pelo servidor", async ({
  page,
}) => {
  const id = await entrar(page);
  // O primeiro envio fica seguro e, solto, segue ao servidor; sabe-se quando a resposta dele voltou.
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  let respondido = () => {};
  const chegou = new Promise<void>((r) => {
    respondido = r;
  });
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await portao;
        await rota.fulfill({ response: await rota.fetch() });
        respondido();
        return;
      }
    }
    await rota.continue();
  });
  await page.goto("/estudos/batismo-e-tentacao");
  await esperarHidratado(campo(page));
  const x = `X-${randomUUID()}`;
  await campo(page).fill(x);
  await expect(estado(page)).toHaveText("Salvando…");
  await campo(page).fill("");
  expect(await chaves(page)).toHaveLength(1);

  await page.getByRole("link", { name: "Anterior" }).click();
  await expect(page).toHaveURL(/\/estudos\/o-nascimento$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/estudos\/batismo-e-tentacao$/);
  await esperarHidratado(campo(page));
  // O editor da volta retoma o escritor e envia o campo de agora (vazio) com o número seguinte.
  await expect(estado(page)).toHaveText("Salvo");
  await expect(campo(page)).toHaveValue("");
  expect(await chaves(page)).toEqual([]);

  // O envio antigo chega AGORA: é velho para aquele escritor e o servidor o recusa.
  liberar();
  await chegou;
  expect(await comTextoDe(id)).toBe(0);
  await expect(campo(page)).toHaveValue("");
});

test("se o campo mudou durante o envio, a resposta não declara Salvo: o editor reenvia o estado atual, inclusive apagar", async ({
  page,
}) => {
  const id = await entrar(page);
  const liberar = await segurarPrimeiroEnvio(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill(`X-${randomUUID()}`);
  await expect(estado(page)).toHaveText("Salvando…");
  await campo(page).fill("");
  liberar();
  await expect(estado(page)).toHaveText("Salvo");
  // O que o servidor guarda é o campo de agora (nada), e não o texto que estava a caminho.
  expect(await comTextoDe(id)).toBe(0);
  expect(await chaves(page)).toEqual([]);
});

test("resposta perdida depois de o servidor gravar: o editor fica incerto e envia a exclusão que a pessoa fez, que o servidor aceita como continuação", async ({
  page,
}) => {
  const id = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  // O PRIMEIRO envio chega ao servidor, que grava, e a resposta é derrubada no caminho de volta.
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await rota.fetch();
        await rota.abort("connectionfailed");
        return;
      }
    }
    await rota.continue();
  });
  const x = `X-${randomUUID()}`;
  await campo(page).fill(x);
  await expect(estado(page)).toContainText("Não foi possível salvar");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(x);

  // A pessoa apaga tudo: o campo é igual à base que o editor conhecia (vazio), mas o servidor TEM o texto.
  await campo(page).fill("");
  // Incerto, o campo conta como não confirmado: a exclusão vai com o número seguinte, sem palpite.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(estado(page)).toHaveText("Salvo");
  expect(await comTextoDe(id)).toBe(0);
  expect(await chaves(page)).toEqual([]);
});

test("resposta perdida sem o servidor ter gravado: o envio seguinte grava sobre a base de sempre", async ({
  page,
}) => {
  const id = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await rota.abort("connectionfailed");
        return;
      }
    }
    await rota.continue();
  });
  const texto = `Y-${randomUUID()}`;
  await campo(page).fill(texto);
  await expect(estado(page)).toContainText("Não foi possível salvar");
  expect(
    await contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(estado(page)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]),
  ).toBe(texto);
});

// ───────────── rodada 9 da revisão (os dois P1 abertos) ─────────────

const comTexto = (id: string, corpo: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1 and corpo = $2", [
    id,
    corpo,
  ]);

test("rodada 9 (a): apagar, perder a resposta da exclusão e redigitar o mesmo texto não declara Salvo com o servidor vazio", async ({
  page,
}) => {
  const id = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const x = `X-${randomUUID()}`;
  await campo(page).fill(x);
  await expect(estado(page)).toHaveText("Salvo");
  // O envio seguinte (a exclusão) chega ao servidor, que grava, e a resposta é derrubada no caminho de volta.
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await rota.fetch();
        await rota.abort("connectionfailed");
        return;
      }
    }
    await rota.continue();
  });
  await campo(page).fill("");
  await expect(estado(page)).toContainText("Não foi possível salvar");
  expect(await comTexto(id, x)).toBe(0);
  // A pessoa escreve de novo o mesmo texto: igual à base que o editor conhecia, mas o servidor está vazio.
  await campo(page).fill(x);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(estado(page)).toHaveText("Salvo");
  expect(await comTexto(id, x)).toBe(1);
});

test("rodada 9 (b): voltar ao Estudo pela página guardada (vazia) com o rascunho de um envio que já chegou não apaga o texto do servidor", async ({
  page,
}) => {
  const id = await entrar(page);
  let liberar = () => {};
  const portao = new Promise<void>((r) => {
    liberar = r;
  });
  let respondido = () => {};
  const chegou = new Promise<void>((r) => {
    respondido = r;
  });
  let envios = 0;
  await page.route("**/*", async (rota) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      envios += 1;
      if (envios === 1) {
        await portao;
        const resposta = await rota.fetch();
        await rota.fulfill({ response: resposta });
        respondido();
        return;
      }
    }
    await rota.continue();
  });
  await page.goto("/estudos/batismo-e-tentacao");
  await esperarHidratado(campo(page));
  const x = `X-${randomUUID()}`;
  await campo(page).fill(x);
  await expect(estado(page)).toHaveText("Salvando…");
  // Durante o envio o campo muda e volta a ser o texto a caminho.
  await campo(page).fill(`${x}a`);
  await campo(page).fill(x);

  await page.getByRole("link", { name: "Anterior" }).click();
  await expect(page).toHaveURL(/\/estudos\/o-nascimento$/);
  liberar();
  await chegou;
  expect(await comTexto(id, x)).toBe(1);

  // Volta pelo histórico: a página vem da memória do navegador, de antes do envio (campo vazio).
  await page.goBack();
  await expect(page).toHaveURL(/\/estudos\/batismo-e-tentacao$/);
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue(x);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(2500);
  expect(await comTexto(id, x)).toBe(1);
});
