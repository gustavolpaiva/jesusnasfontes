import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { emailsPara } from "../../support/caixa-de-email";
import { entrarComoAdmin } from "../../support/login-admin-e2e";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  isolarIp,
  lerTexto,
  linhasDe,
  pedirAcesso,
  sessoesDe,
} from "../../support/login-e2e";

// Convites pela tela (AUTH-01): o Admin convida e vê o convite Pendente; ninguém mais alcança a tela.

test("Admin convida pela tela, vê o convite Pendente e o e-mail de convite sai sem link de entrada", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  await expect(page.getByRole("heading", { level: 1, name: "Convites" })).toBeVisible();
  // Controle: antes de convidar, só existe o convite do próprio Admin.
  await expect(page.getByRole("heading", { level: 2, name: /^Convidados \(\d+\)$/ })).toBeVisible();

  const convidado = emailDeTeste("convidado");
  await page.getByLabel("E-mail da pessoa").fill(convidado);
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText(`Convite registrado e enviado para ${convidado}.`)).toBeVisible();

  const linha = page.getByRole("listitem").filter({ hasText: convidado });
  await expect(linha.getByText("Pendente", { exact: true })).toBeVisible();
  await expect(page.getByLabel("E-mail da pessoa")).toHaveValue("");

  // O e-mail de convite chegou ao transporte em arquivo e não traz link de entrada.
  const emails = emailsPara(convidado).filter((m) => /convite/i.test(m.assunto));
  expect(emails).toHaveLength(1);
  expect(emails[0]?.texto).not.toContain("/entrar/confirmar");
  expect(emails[0]?.link).toBeNull();
});

test("convite duplicado e e-mail malformado mostram o texto do contrato e mantêm o que foi digitado", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const campo = page.getByLabel("E-mail da pessoa");

  await campo.fill("sem-arroba");
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(
    page.getByText("Esse e-mail parece incompleto. Confira e tente de novo."),
  ).toBeVisible();
  await expect(campo).toHaveValue("sem-arroba");

  const convidado = emailDeTeste("duplicado");
  await campo.fill(convidado);
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText(`Convite registrado e enviado para ${convidado}.`)).toBeVisible();
  await campo.fill(convidado.toUpperCase());
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText("Este e-mail já tem convite. Use Reenviar na lista.")).toBeVisible();
  await expect(campo).toHaveValue(convidado.toUpperCase());
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [convidado]),
  ).toBe(1);
  expect(emailsPara(convidado).filter((m) => /convite/i.test(m.assunto))).toHaveLength(1);
});

test("Estudante comum recebe a 404 em /admin/convites e a ação de convidar recusa no servidor", async ({
  browser,
  page,
}) => {
  // O Admin dispara a ação de verdade e a requisição é capturada para ser repetida pelo Estudante.
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const pedido = page.waitForRequest((r) => r.method() === "POST" && !!r.headers()["next-action"]);
  await page.getByLabel("E-mail da pessoa").fill(emailDeTeste("controle"));
  await page.getByRole("button", { name: "Convidar" }).click();
  const acaoReal = await pedido;
  await expect(page.getByText(/Convite registrado e enviado para/)).toBeVisible();

  const estudante = emailDeTeste("estudante");
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  await aba.goto("/admin/convites");
  await expect(aba.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();

  // Mesma requisição, agora com o cookie do Estudante: nada é criado.
  const alvo = emailDeTeste("invasor");
  const cabecalhos: Record<string, string> = {
    ...acaoReal.headers(),
    origin: new URL(acaoReal.url()).origin,
  };
  delete cabecalhos.cookie;
  delete cabecalhos["content-length"];
  delete cabecalhos["content-type"];
  const corpo = acaoReal.postDataBuffer()?.toString("latin1") ?? "";
  // O corpo é multipart; o endereço do convite do Admin é trocado pelo do invasor.
  const trocado = corpo.replace(/controle-[0-9a-f]+@convite\.example/, alvo);
  expect(trocado).toContain(alvo);
  const resposta = await contexto.request.post(new URL(acaoReal.url()).pathname, {
    headers: { ...cabecalhos, "content-type": acaoReal.headers()["content-type"] ?? "" },
    data: Buffer.from(trocado, "latin1"),
    maxRedirects: 0,
  });
  expect(resposta.status()).toBe(404);
  // Controle positivo: a mesma requisição adulterada, com o cookie do Admin, é processada.
  const comoAdmin = emailDeTeste("controle-admin");
  const respostaAdmin = await page.context().request.post(new URL(acaoReal.url()).pathname, {
    headers: { ...cabecalhos, "content-type": acaoReal.headers()["content-type"] ?? "" },
    data: Buffer.from(corpo.replace(/controle-[0-9a-f]+@convite\.example/, comoAdmin), "latin1"),
    maxRedirects: 0,
  });
  expect(respostaAdmin.status()).toBe(200);
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [comoAdmin]),
  ).toBe(1);
  expect(
    await contar("select count(*) as n from admin.convite where email_norm = $1", [alvo]),
  ).toBe(0);
  expect(emailsPara(alvo)).toHaveLength(0);
});

// ── Reenviar e revogar (AUTH-06) ──────────────────────────────────────────────────────────────────

const aoConvite = (page: Page, email: string) =>
  page.getByRole("listitem").filter({ hasText: email });
const dialogo = (page: Page) => page.getByRole("alertdialog");

async function convidarPelaTelaDe(page: Page, email: string): Promise<void> {
  await page.getByLabel("E-mail da pessoa").fill(email);
  await page.getByRole("button", { name: "Convidar" }).click();
  await expect(page.getByText(`Convite registrado e enviado para ${email}.`)).toBeVisible();
}

// Espera o React ligar o botão antes de contar com o diálogo (o clique antes da hidratação não abre nada).
async function abrirRevogar(page: Page, email: string): Promise<void> {
  await expect(async () => {
    await page.getByRole("button", { name: `Revogar convite de ${email}` }).click();
    await expect(dialogo(page)).toBeVisible({ timeout: 1000 });
  }).toPass();
}

// Marca o convite como Aceito direto no banco (a pessoa "já entrou"), sem abrir um navegador por pessoa.
async function aceitarNoBanco(email: string): Promise<void> {
  await convidarParaTeste(email);
  await escrever(
    "update admin.convite set estado = 'aceito', aceito_em = now() where email_norm = $1",
    [email],
  );
}

const convitesDe = (email: string) =>
  emailsPara(email).filter((m) => /convite/i.test(m.assunto)).length;

test("Admin revoga um convite Aceito: a pessoa perde a sessão, o pedido novo recebe a resposta neutra e nenhum e-mail sai", async ({
  browser,
  page,
}) => {
  await entrarComoAdmin(page);
  const estudante = emailDeTeste("revogado");
  await convidarParaTeste(estudante);
  const vizinho = emailDeTeste("vizinho");
  await convidarParaTeste(vizinho);

  // O Estudante entra num contexto à parte e fica com uma Sessão aberta.
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  const outroContexto = await browser.newContext();
  const abaVizinho = await outroContexto.newPage();
  await entrarPorLink(abaVizinho, vizinho);
  expect(await sessoesDe(estudante)).toBe(1);

  await page.goto("/admin/convites");
  await expect(aoConvite(page, estudante).getByText("Aceito", { exact: true })).toBeVisible();
  await abrirRevogar(page, estudante);
  // O foco inicial é "Cancelar" e o texto é o do convite Aceito.
  await expect(dialogo(page).getByRole("button", { name: "Cancelar" })).toBeFocused();
  await expect(dialogo(page)).toContainText(
    `${estudante} sai de todos os aparelhos e não consegue mais entrar. Os dados da pessoa não são apagados.`,
  );
  // Esc fecha sem revogar.
  await page.keyboard.press("Escape");
  await expect(dialogo(page)).toBeHidden();
  expect(await sessoesDe(estudante)).toBe(1);

  await abrirRevogar(page, estudante);
  await dialogo(page).getByRole("button", { name: "Revogar convite", exact: true }).click();
  await expect(page.getByText("Convite revogado.")).toBeVisible();
  const linha = aoConvite(page, estudante);
  await expect(linha.getByText("Revogado", { exact: true })).toBeVisible();
  await expect(linha.getByRole("button")).toHaveCount(0);

  // Efeito imediato: a sessão sumiu do banco e a próxima navegação da pessoa cai em /entrar.
  expect(await sessoesDe(estudante)).toBe(0);
  await aba.goto("/trilhas");
  await expect(aba).toHaveURL(/\/entrar/);
  // Os dados da pessoa ficam (a conta continua).
  expect(await linhasDe(estudante)).toMatchObject({ usuarios: 1, convites: 1 });

  // Novo pedido de acesso: resposta neutra, nenhum e-mail de acesso, nenhuma verificação nova.
  const acessosAntes = emailsPara(estudante).filter((m) => /acesso/i.test(m.assunto)).length;
  await isolarIp(aba);
  await pedirAcesso(aba, estudante);
  await aba.waitForTimeout(1000);
  expect(emailsPara(estudante).filter((m) => /acesso/i.test(m.assunto))).toHaveLength(acessosAntes);
  expect((await linhasDe(estudante)).verificacoes).toBe(0);

  // Controle negativo: a pessoa vizinha continua dentro.
  expect(await sessoesDe(vizinho)).toBe(1);
  await abaVizinho.goto("/trilhas");
  await expect(abaVizinho.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
});

test("revogar um convite Pendente apaga a conta vazia e usa o texto do convite Pendente", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const pendente = emailDeTeste("pendente");
  await convidarPelaTelaDe(page, pendente);
  await expect(aoConvite(page, pendente).getByText("Pendente", { exact: true })).toBeVisible();
  expect((await linhasDe(pendente)).usuarios).toBe(1);

  await abrirRevogar(page, pendente);
  await expect(dialogo(page)).toContainText(`${pendente} não poderá mais entrar com este convite.`);
  await dialogo(page).getByRole("button", { name: "Revogar convite", exact: true }).click();
  await expect(page.getByText("Convite revogado.")).toBeVisible();
  await expect(aoConvite(page, pendente).getByText("Revogado", { exact: true })).toBeVisible();
  expect(await linhasDe(pendente)).toMatchObject({ usuarios: 0, convites: 1 });
});

test("reenviar: só em Pendente, três vezes por hora, e o quarto pedido mostra o limite sem enviar", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const alvo = emailDeTeste("reenvio");
  await convidarPelaTelaDe(page, alvo);
  expect(convitesDe(alvo)).toBe(1);

  const botao = page.getByRole("button", { name: `Reenviar convite para ${alvo}` });
  for (let n = 2; n <= 4; n++) {
    await botao.click();
    await expect(page.getByText(`Convite reenviado para ${alvo}.`)).toBeVisible();
    await expect.poll(() => convitesDe(alvo)).toBe(n);
    // O próximo clique só vem depois de a mensagem anterior sair da tela: o texto é igual.
    if (n < 4) {
      await page.reload();
      await page.getByRole("heading", { level: 2, name: /Convidados/ }).waitFor();
    }
  }
  await page.reload();
  await botao.click();
  await expect(
    page.getByText(
      "Você já reenviou este convite três vezes na última hora. Espere um pouco e tente de novo.",
    ),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(convitesDe(alvo)).toBe(4);

  // "Reenviar" não existe em convite Aceito nem Revogado.
  const aceito = emailDeTeste("aceito");
  await aceitarNoBanco(aceito);
  await page.reload();
  await expect(page.getByRole("button", { name: `Reenviar convite para ${aceito}` })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: `Revogar convite de ${aceito}` })).toHaveCount(1);
});

test("o Admin não tem ação sobre o próprio convite e o servidor recusa o pedido repetido; o Estudante recebe 404", async ({
  browser,
  page,
}) => {
  const { endereco } = await entrarComoAdmin(page);
  const vitima = emailDeTeste("alvo");
  await aceitarNoBanco(vitima);
  await page.goto("/admin/convites");
  await expect(aoConvite(page, endereco).getByText("Seu convite")).toBeVisible();
  await expect(aoConvite(page, endereco).getByRole("button")).toHaveCount(0);

  // Captura a Server Action de revogar numa revogação real de OUTRO convite (a da "vítima" fica para
  // depois: aqui se revoga um terceiro, só para ter o pedido).
  const terceiro = emailDeTeste("terceiro");
  await convidarPelaTelaDe(page, terceiro);
  const pedido = page.waitForRequest(
    (r) => r.method() === "POST" && !!r.headers()["next-action"] && !!r.postData()?.startsWith("["),
  );
  await abrirRevogar(page, terceiro);
  await dialogo(page).getByRole("button", { name: "Revogar convite", exact: true }).click();
  const acaoReal = await pedido;
  await expect(page.getByText("Convite revogado.")).toBeVisible();
  const idTerceiro = (await lerTexto(
    "select id::text as t from admin.convite where email_norm = $1",
    [terceiro],
  )) as string;
  const idProprio = await lerTexto(
    "select id::text as t from admin.convite where email_norm = $1",
    [endereco],
  );
  const idVitima = await lerTexto("select id::text as t from admin.convite where email_norm = $1", [
    vitima,
  ]);
  expect(acaoReal.postData()).toContain(idTerceiro);

  const cabecalhos: Record<string, string> = {
    ...acaoReal.headers(),
    origin: new URL(acaoReal.url()).origin,
  };
  delete cabecalhos.cookie;
  delete cabecalhos["content-length"];
  const repetir = (contexto: BrowserContext, id: string) =>
    contexto.request.post(new URL(acaoReal.url()).pathname, {
      headers: cabecalhos,
      data: JSON.stringify([id]),
      maxRedirects: 0,
    });

  // O Admin pedindo a revogação do PRÓPRIO convite: a ação recusa e nada muda.
  const recusada = await repetir(page.context(), idProprio);
  expect(recusada.status()).toBe(200);
  expect(await recusada.text()).toContain("proprio");
  expect(await lerTexto("select estado as t from admin.convite where id = $1", [idProprio])).toBe(
    "aceito",
  );
  await page.goto("/admin/convites");
  await expect(aoConvite(page, endereco).getByText("Aceito", { exact: true })).toBeVisible();

  // Estudante comum repetindo o pedido com o convite da vítima: 404, e a vítima segue Aceita.
  const estudante = emailDeTeste("estudante");
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  const negada = await repetir(contexto, idVitima);
  expect(negada.status()).toBe(404);
  expect(await lerTexto("select estado as t from admin.convite where id = $1", [idVitima])).toBe(
    "aceito",
  );
});

test("os três estados se distinguem sem cor, o e-mail longo quebra sem estourar", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/admin/convites");
  const longo = `${"pessoa-com-um-endereco-muito-comprido-".repeat(3)}${emailDeTeste("x")}`;
  await convidarPelaTelaDe(page, longo);
  const aceito = emailDeTeste("aceito");
  await aceitarNoBanco(aceito);
  const revogado = emailDeTeste("revogado");
  await aceitarNoBanco(revogado);
  await page.reload();
  await abrirRevogar(page, revogado);
  await dialogo(page).getByRole("button", { name: "Revogar convite", exact: true }).click();
  await expect(page.getByText("Convite revogado.")).toBeVisible();

  const estilo = (email: string, estado: string) =>
    aoConvite(page, email)
      .getByText(estado, { exact: true })
      .evaluate((el) => {
        const c = getComputedStyle(el);
        return { borda: c.borderTopStyle, cor: c.borderTopColor, texto: c.color };
      });
  const pendente = await estilo(longo, "Pendente");
  const aceitoEstilo = await estilo(aceito, "Aceito");
  const revogadoEstilo = await estilo(revogado, "Revogado");
  expect(pendente.borda).toBe("dashed");
  expect(aceitoEstilo.borda).toBe("solid");
  expect(revogadoEstilo.borda).toBe("solid");
  // Sem depender de cor: Aceito e Revogado diferem na cor da borda e do texto; o e-mail revogado é riscado.
  expect(revogadoEstilo.cor).not.toBe(aceitoEstilo.cor);
  const riscado = await aoConvite(page, revogado)
    .getByText(revogado, { exact: true })
    .evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(riscado).toContain("line-through");

  // Nenhuma rolagem horizontal com o e-mail longo.
  const estouro = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(estouro).toBeLessThanOrEqual(0);
});

test("o link Convites da navegação das Trilhas leva à lista de convites do Admin", async ({
  page,
}) => {
  await entrarComoAdmin(page);
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  const link = page.getByRole("navigation", { name: "Seções" }).getByRole("link", {
    name: "Convites",
  });
  await expect(link).toHaveAttribute("href", "/admin/convites");
  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: "Convites" })).toBeVisible();
});
