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

// Anotação (ANOT-01, ANOT-02): digitar no Estudo, salvar sozinha 1,5 s depois, reencontrar o texto ao reabrir;
// rascunho no aparelho quando a conexão cai; limite; apagar. Roda sobre o conteúdo mínimo de teste
// (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

const ESTUDO = "/estudos/o-nascimento";

async function entrar(page: Page): Promise<{ email: string; id: string }> {
  const email = emailDeTeste("anot");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return { email, id: await idDoUsuario(email) };
}

const campo = (page: Page) => page.getByRole("textbox", { name: "Minha anotação" });
const estado = (page: Page) => page.locator('[data-slot="save-status"]');
const anotacoesDe = (id: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]);
const corpoDe = (id: string) =>
  lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]);
const versaoDe = (id: string) =>
  contar("select versao as n from privado.anotacao where estudante_id = $1", [id]);

// As chaves de rascunho que o aparelho guarda agora.
const chavesDeRascunho = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.localStorage).filter((c) => c.startsWith("jnf:rascunho:")),
  );

// Guarda, desde antes da página montar, cada texto que o estado de salvamento passa a mostrar: provar que
// um estado de 1,5 s apareceu não pode depender de olhar no instante certo.
async function registrarEstados(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __estados: string[] };
    w.__estados = [];
    const ligar = () => {
      const alvo = document.querySelector('[data-slot="save-status"]');
      if (!alvo) {
        requestAnimationFrame(ligar);
        return;
      }
      new MutationObserver(() => {
        const t = (alvo.textContent ?? "").trim();
        if (t && w.__estados[w.__estados.length - 1] !== t) w.__estados.push(t);
      }).observe(alvo, { childList: true, subtree: true, characterData: true });
    };
    ligar();
  });
}
const estadosVistos = (page: Page) =>
  page.evaluate(() => (window as unknown as { __estados: string[] }).__estados);

test("digitar, ver Salvo, recarregar e ver o texto; editar de novo incrementa a versão", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await registrarEstados(page);
  await page.goto(ESTUDO);

  // Estudo sem Anotação: o campo vazio com o rótulo e a ajuda do contrato, sem texto de preenchimento.
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
  await expect(campo(page)).not.toHaveAttribute("placeholder", /.+/);
  await expect(
    page.getByText("Privada: nenhum Estudante nem Admin lê pelo site. Salva sozinha."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Como funciona" })).toHaveAttribute(
    "href",
    "/privacidade",
  );

  await campo(page).fill("Primeira Anotação, escrita com calma.");
  // O primeiro caractere já está no rascunho do aparelho, antes de o servidor receber nada.
  expect(await chavesDeRascunho(page)).toHaveLength(1);
  await expect(estado(page)).toHaveText("Salvo");
  expect(await estadosVistos(page)).toContain("Salvando…");
  // Salvo no servidor, uma linha, versão 1; o rascunho local saiu.
  expect(await anotacoesDe(id)).toBe(1);
  expect(await corpoDe(id)).toBe("Primeira Anotação, escrita com calma.");
  expect(await versaoDe(id)).toBe(1);
  expect(await chavesDeRascunho(page)).toHaveLength(0);

  // Recarregar: o texto volta igual, do servidor.
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("Primeira Anotação, escrita com calma.");

  // Editar de novo incrementa a versão e não cria outra linha.
  await campo(page).fill("Primeira Anotação, escrita com calma. Mais uma frase.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await versaoDe(id)).toBe(2);
  expect(await anotacoesDe(id)).toBe(1);
});

test("apagar todo o texto apaga o texto do servidor (a linha fica vazia, para guardar a ordem) e o Caderno não a mostra", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill("Vai ser apagada.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await anotacoesDe(id)).toBe(1);
  await campo(page).fill("");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await corpoDe(id)).toBe("");
  await page.goto("/caderno");
  await expect(page.getByText("Seu Caderno está vazio")).toBeVisible();
  await expect(page.locator('[data-slot="entrada-caderno"]')).toHaveCount(0);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
});

test("a Anotação é de cada Estudo: outro Estudo abre vazio e a primeira continua lá", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill("Do primeiro Estudo.");
  await expect(estado(page)).toHaveText("Salvo");
  await page.goto("/estudos/batismo-e-tentacao");
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
  await campo(page).fill("Do segundo Estudo.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await anotacoesDe(id)).toBe(2);
  await page.goto(ESTUDO);
  await expect(campo(page)).toHaveValue("Do primeiro Estudo.");
});

// ───────────── sem conexão, falha, limite, aparelho compartilhado ─────────────

// Corta só o envio da Anotação (o corpo traz `versaoBase`), deixando passar o resto (sair, por exemplo).
async function cortarEnvioDaAnotacao(page: Page): Promise<() => Promise<void>> {
  const tratador = async (rota: import("@playwright/test").Route) => {
    const pedido = rota.request();
    if (pedido.method() === "POST" && (pedido.postData() ?? "").includes("versaoBase")) {
      await rota.abort("connectionfailed");
    } else await rota.continue();
  };
  await page.route("**/*", tratador);
  return () => page.unroute("**/*", tratador);
}

test("sem conexão o texto continua sendo guardado neste aparelho e vai ao servidor quando a conexão volta", async ({
  page,
  context,
}) => {
  const { id } = await entrar(page);
  await registrarEstados(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));

  await context.setOffline(true);
  await campo(page).fill("Escrito sem conexão.");
  await expect(estado(page)).toHaveText("Sem conexão: rascunho guardado neste aparelho.");
  // O rascunho existe no aparelho, com o texto; o servidor não recebeu nada.
  const guardado = await page.evaluate(() => {
    const chave = Object.keys(window.localStorage).find((c) => c.startsWith("jnf:rascunho:"));
    return chave
      ? (JSON.parse(window.localStorage.getItem(chave) ?? "{}") as { corpo?: string })
      : null;
  });
  expect(guardado?.corpo).toBe("Escrito sem conexão.");
  expect(await anotacoesDe(id)).toBe(0);
  // O texto continua sendo escrito.
  await campo(page).fill("Escrito sem conexão. E mais um pouco.");
  await expect(estado(page)).toHaveText("Sem conexão: rascunho guardado neste aparelho.");

  await context.setOffline(false);
  await expect(estado(page)).toHaveText("Salvo");
  expect(await corpoDe(id)).toBe("Escrito sem conexão. E mais um pouco.");
  expect(await chavesDeRascunho(page)).toHaveLength(0);
});

test("o servidor fora do ar não perde o texto: recarregar traz o rascunho de volta e ele é enviado depois", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await registrarEstados(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const religar = await cortarEnvioDaAnotacao(page);

  await campo(page).fill("Texto que o servidor não recebeu.");
  await expect(estado(page)).toContainText(
    "Não foi possível salvar. O texto continua neste aparelho",
  );
  expect(await anotacoesDe(id)).toBe(0);

  // Recarregar com o servidor ainda sem receber: o rascunho volta, com o aviso do contrato.
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("Texto que o servidor não recebeu.");
  await expect
    .poll(() => estadosVistos(page))
    .toContain("Rascunho recuperado deste aparelho. Ainda não foi enviado.");
  expect(await anotacoesDe(id)).toBe(0);

  // A conexão volta: o rascunho vai e o servidor fica igual a ele.
  await religar();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(estado(page)).toHaveText("Salvo");
  expect(await corpoDe(id)).toBe("Texto que o servidor não recebeu.");
  expect(await chavesDeRascunho(page)).toHaveLength(0);
});

test("passar de 20 000 caracteres mostra o erro do contrato, não envia e o texto fica neste aparelho", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill("a".repeat(20_001));
  await expect(estado(page)).toHaveText(
    "Erro. A Anotação passou do limite de 20 000 caracteres. Apague um trecho para continuar salvando.",
  );
  await expect(campo(page)).toHaveAttribute("aria-invalid", "true");
  // Espera mais que o tempo de salvar sozinho: nada pode ter ido ao servidor.
  await page.waitForTimeout(2200);
  expect(await anotacoesDe(id)).toBe(0);
  expect(await chavesDeRascunho(page)).toHaveLength(1);
  // Apagando um trecho, volta a salvar.
  await campo(page).fill("a".repeat(20_000));
  await expect(estado(page)).toHaveText("Salvo");
  expect(await anotacoesDe(id)).toBe(1);
});

test("depois de sair, o aparelho não guarda rascunho algum", async ({ page }) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill("Já enviada.");
  await expect(estado(page)).toHaveText("Salvo");
  // Um texto novo que o servidor não recebe fica como rascunho.
  await cortarEnvioDaAnotacao(page);
  await campo(page).fill("Ainda não enviada.");
  await expect(estado(page)).toContainText("Não foi possível salvar");
  expect(await chavesDeRascunho(page)).toHaveLength(1);

  await page.getByRole("button", { name: "Abrir menu" }).click();
  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page.getByText("Você saiu.")).toBeVisible();
  expect(await chavesDeRascunho(page)).toHaveLength(0);
  // O que o servidor tinha antes continua (sair não apaga a Anotação, só o rascunho do aparelho).
  expect(await corpoDe(id)).toBe("Já enviada.");
});

test("rascunho de outra conta no mesmo aparelho é removido ao abrir um Estudo; o desta conta fica", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const estudoId = await lerTexto(
    "select id::text as t from conteudo.estudo where slug = 'o-nascimento'",
  );
  await page.evaluate(
    ([dono, estudo, propria]) => {
      const rascunho = (corpo: string) =>
        JSON.stringify({ corpo, versaoBase: 0, baseId: null, salvoEm: Date.now() });
      window.localStorage.setItem(`jnf:rascunho:${dono}:${estudo}`, rascunho("de outra pessoa"));
      window.localStorage.setItem(`jnf:rascunho:${propria}:outro-estudo`, rascunho("meu"));
    },
    ["11111111-1111-4111-8111-111111111111", estudoId, id],
  );
  await page.reload();
  await esperarHidratado(campo(page));
  const chaves = await chavesDeRascunho(page);
  expect(chaves).toEqual([`jnf:rascunho:${id}:outro-estudo`]);
});

test("a tela de entrada apaga os rascunhos depois de sair ou de apagar a conta, e não depois de a sessão expirar", async ({
  page,
}) => {
  await page.goto("/entrar");
  const semear = () =>
    page.evaluate(() =>
      window.localStorage.setItem(
        "jnf:rascunho:22222222-2222-4222-8222-222222222222:x",
        JSON.stringify({ corpo: "t", versaoBase: 0, baseId: null, salvoEm: 1 }),
      ),
    );
  const quantos = () =>
    page.evaluate(
      () => Object.keys(window.localStorage).filter((c) => c.startsWith("jnf:rascunho:")).length,
    );
  // Sessão expirada: a pessoa não saiu, o texto ainda não enviado é dela.
  await semear();
  await page.goto("/entrar?motivo=sessao");
  await expect(page.getByText("Sua sessão terminou. Entre de novo.")).toBeVisible();
  expect(await quantos()).toBe(1);
  // Saiu.
  await page.goto("/entrar?saiu=1");
  await expect(page.getByText("Você saiu.")).toBeVisible();
  await expect.poll(quantos).toBe(0);
  // Conta apagada.
  await semear();
  await page.goto("/entrar?apagada=1");
  await expect(page.getByText("Sua conta foi apagada.")).toBeVisible();
  await expect.poll(quantos).toBe(0);
});
