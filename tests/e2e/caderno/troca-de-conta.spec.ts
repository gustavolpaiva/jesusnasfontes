import { randomUUID } from "node:crypto";
import { expect, type Page, type Route, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
  lerTexto,
} from "../../support/login-e2e";

// Revisão do Codex sobre o plano 01-18 (P1, privacidade): o que a tela de A tem para enviar nunca pode ser
// gravado na conta de B quando a conta muda no mesmo navegador (a sessão é um cookie, comum a todas as
// abas). Roda sobre o conteúdo mínimo (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

const ESTUDO = "/estudos/o-nascimento";
const campo = (p: Page) => p.getByRole("textbox", { name: "Minha anotação" });
const estado = (p: Page) => p.locator('[data-slot="save-status"]');
const doEstudante = (id: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]);
const chaves = (p: Page) =>
  p.evaluate(() => Object.keys(window.localStorage).filter((c) => c.startsWith("jnf:rascunho:")));

async function conta(page: Page, prefixo: string): Promise<{ email: string; id: string }> {
  const email = emailDeTeste(prefixo);
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return { email, id: await idDoUsuario(email) };
}

// Corta só o envio da Anotação (o corpo traz `versaoBase`), deixando passar o resto.
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

test("a aba de A com texto pendente não grava na conta de B depois de a conta trocar no navegador", async ({
  page,
  context,
}) => {
  const a = await conta(page, "troca-a");
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const religar = await cortarEnvio(page);
  const segredo = `SEGREDO-DE-A-${randomUUID()}`;
  await campo(page).fill(segredo);
  await expect(estado(page)).toContainText("Não foi possível salvar");

  // Outra aba do mesmo navegador: A sai e B entra.
  const outra = await context.newPage();
  await outra.goto("/trilhas");
  await outra.getByRole("button", { name: "Abrir menu" }).click();
  await outra.getByRole("button", { name: "Sair" }).click();
  await expect(outra.getByText("Você saiu.")).toBeVisible();
  const b = await conta(outra, "troca-b");

  // O envio volta (a conexão, o `online`, a aba visível de novo): a aba de A NÃO pode escrever em B.
  await religar();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  // Saiu em outra aba: o editor de A se encerra (a marca da saída mudou) e nunca mais envia.
  await expect(estado(page)).toContainText("A conta saiu deste navegador");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(2200);
  expect(await doEstudante(b.id)).toBe(0);
  expect(await doEstudante(a.id)).toBe(0);
  // O texto continua na tela de A (para copiar), parado: a tela não deixa mais escrever.
  await expect(campo(page)).toHaveValue(segredo);
  await expect(campo(page)).toHaveAttribute("readonly", "");

  // B abre o mesmo Estudo: campo vazio, e nada do texto de A.
  await outra.goto(ESTUDO);
  await esperarHidratado(campo(outra));
  await expect(campo(outra)).toHaveValue("");
});

test("sair em outra aba encerra o editor de A: o reenvio dele não recria o rascunho de A no aparelho depois da limpeza (revisão, rodada 10)", async ({
  page,
  context,
}) => {
  const a = await conta(page, "saida-a");
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const religar = await cortarEnvio(page);
  const segredo = `PENDENTE-DE-A-${randomUUID()}`;
  await campo(page).fill(segredo);
  await expect(estado(page)).toContainText("Não foi possível salvar");
  expect(await chaves(page)).toEqual([expect.stringContaining(a.id)]);

  // Outra aba: A sai (a limpeza apaga o rascunho) e B entra.
  const outra = await context.newPage();
  await outra.goto("/trilhas");
  await outra.getByRole("button", { name: "Abrir menu" }).click();
  await outra.getByRole("button", { name: "Sair" }).click();
  await expect(outra.getByText("Você saiu.")).toBeVisible();
  await expect.poll(() => chaves(outra)).toEqual([]);
  const b = await conta(outra, "saida-b");

  // Daqui em diante a aba de A não pode gravar rascunho algum: toda escrita é anotada.
  await page.evaluate(() => {
    const w = window as unknown as { escritasDeRascunho: string[] };
    w.escritasDeRascunho = [];
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (chave: string, valor: string) {
      if (chave.startsWith("jnf:rascunho:")) w.escritasDeRascunho.push(chave);
      return original.call(this, chave, valor);
    };
  });
  // O envio volta e as oportunidades de reenvio chegam (conexão, aba visível).
  await religar();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(2200);
  expect(
    await page.evaluate(
      () => (window as unknown as { escritasDeRascunho: string[] }).escritasDeRascunho,
    ),
  ).toEqual([]);
  expect(await chaves(page)).toEqual([]);
  expect(
    await page.evaluate(
      (texto) =>
        Object.keys(window.localStorage).some((c) =>
          (window.localStorage.getItem(c) ?? "").includes(texto),
        ),
      segredo,
    ),
  ).toBe(false);
  expect(await doEstudante(a.id)).toBe(0);
  expect(await doEstudante(b.id)).toBe(0);
  // O texto continua na tela de A, só para copiar.
  await expect(campo(page)).toHaveValue(segredo);
});

test("o rascunho de A neste aparelho nunca aparece nem é reenviado para B no mesmo navegador", async ({
  page,
  context,
}) => {
  const a = await conta(page, "rasc-a");
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await cortarEnvio(page);
  const segredo = `RASCUNHO-DE-A-${randomUUID()}`;
  await campo(page).fill(segredo);
  await expect(estado(page)).toContainText("Não foi possível salvar");
  expect(await chaves(page)).toHaveLength(1);
  expect(await chaves(page)).toEqual([expect.stringContaining(a.id)]);
  await page.close();

  // A conta muda SEM passar por Sair (que apagaria o rascunho): o rascunho de A fica no aparelho.
  await context.clearCookies();
  const nova = await context.newPage();
  const enviosDeAnotacao: string[] = [];
  nova.on("request", (r) => {
    if (r.method() === "POST" && (r.postData() ?? "").includes("versaoBase")) {
      enviosDeAnotacao.push(r.url());
    }
  });
  const b = await conta(nova, "rasc-b");
  // O rascunho de A ainda está no aparelho quando B entra.
  expect(await chaves(nova)).toEqual([expect.stringContaining(a.id)]);
  await nova.goto(ESTUDO);
  await esperarHidratado(campo(nova));
  await expect(campo(nova)).toHaveValue("");
  await expect(estado(nova)).toHaveText("");
  await nova.waitForTimeout(2200);
  expect(enviosDeAnotacao).toEqual([]);
  expect(await doEstudante(b.id)).toBe(0);
  expect(await doEstudante(a.id)).toBe(0);
  // E o rascunho de A não fica para outra conta ver depois.
  expect(await chaves(nova)).toEqual([]);
});

test("Tentar de novo no Caderno recupera quando a leitura volta (revisão do Codex, P2)", async ({
  page,
}) => {
  const { id } = await conta(page, "retry");
  await escrever(
    `insert into privado.anotacao (estudante_id, estudo_id, corpo)
     select $1, id, 'Anotação para o Caderno recuperar' from conteudo.estudo where slug = 'o-nascimento'`,
    [id],
  );
  // Falha só para esta conta: uma política restritiva que divide por zero ao ler as linhas dela.
  const politica = `falha_${id.replaceAll("-", "").slice(0, 12)}`;
  await escrever(
    `create policy ${politica} on privado.anotacao as restrictive using (
       estudante_id <> '${id}'::uuid or (length(corpo) / (length(corpo) - length(corpo))) = 1)`,
  );
  try {
    await page.goto("/caderno");
    await expect(page.getByText("Não conseguimos buscar agora. Tente de novo.")).toBeVisible();
    const tentar = page.getByRole("button", { name: "Tentar de novo" });
    await esperarHidratado(tentar);
    await escrever(`drop policy ${politica} on privado.anotacao`);
    await tentar.click();
    await expect(page.locator('[data-slot="entrada-caderno"]')).toHaveCount(1);
    await expect(page.getByText("Não conseguimos buscar agora. Tente de novo.")).toHaveCount(0);
    await expect(page.getByText("Anotação para o Caderno recuperar")).toBeVisible();
  } finally {
    await escrever(`drop policy if exists ${politica} on privado.anotacao`);
  }
});

test("a busca da aba de A depois de a conta trocar não traz o Caderno de B para a tela de A", async ({
  page,
  context,
}) => {
  await conta(page, "busca-a");
  await page.goto("/caderno");
  const buscar = page.getByRole("button", { name: "Buscar", exact: true });
  await esperarHidratado(buscar);
  const outra = await context.newPage();
  await outra.goto("/trilhas");
  await outra.getByRole("button", { name: "Abrir menu" }).click();
  await outra.getByRole("button", { name: "Sair" }).click();
  await expect(outra.getByText("Você saiu.")).toBeVisible();
  const b = await conta(outra, "busca-b");
  const palavra = `soDeB${randomUUID().slice(0, 8)}`;
  await escrever(
    `insert into privado.anotacao (estudante_id, estudo_id, corpo)
     select $1, id, $2 from conteudo.estudo where slug = 'o-nascimento'`,
    [b.id, `texto de B com ${palavra}`],
  );
  await page.getByRole("searchbox", { name: "Buscar nas Anotações" }).fill(palavra);
  await buscar.click();
  await expect(
    page.getByText("Este navegador entrou com outra conta. Recarregue a página."),
  ).toBeVisible();
  await expect(page.locator("main").getByText(palavra)).toHaveCount(0);
  await expect(page.locator('[data-slot="entrada-caderno"]')).toHaveCount(0);
});

test("a página refeita com outra conta (marcar concluído na aba de A) troca o editor: o texto de A não fica na tela nem vai para B", async ({
  page,
  context,
}) => {
  const a = await conta(page, "refaz-a");
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  const religar = await cortarEnvio(page);
  const segredo = `SEGREDO-DE-A-${randomUUID()}`;
  await campo(page).fill(segredo);
  await expect(estado(page)).toContainText("Não foi possível salvar");

  const outra = await context.newPage();
  await outra.goto("/trilhas");
  await outra.getByRole("button", { name: "Abrir menu" }).click();
  await outra.getByRole("button", { name: "Sair" }).click();
  await expect(outra.getByText("Você saiu.")).toBeVisible();
  const b = await conta(outra, "refaz-b");

  // A aba de A age (marcar concluído roda com a sessão de agora) e a página se refaz para B.
  const concluir = page.getByRole("button", { name: "Marcar como concluído" });
  await esperarHidratado(concluir);
  await concluir.click();
  await expect(campo(page)).toHaveValue("");
  await religar();
  await campo(page).fill("Texto escrito por B.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(
    await lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [b.id]),
  ).toBe("Texto escrito por B.");
  expect(await doEstudante(a.id)).toBe(0);
  expect(
    await contar("select count(*) as n from privado.anotacao where corpo like $1", [
      `%${segredo}%`,
    ]),
  ).toBe(0);
});
