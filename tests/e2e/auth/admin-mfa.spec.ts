import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  escrever,
  idDoUsuario,
  isolarIp,
  liberarLimitesDePedido,
  recuperarSegundoFatorParaTeste,
  semearAdminParaTeste,
  sessoesDe,
} from "../../support/login-e2e";
import { gerarTotp } from "../../support/totp";

// Segundo fator do Admin (AUTH-08). Cada teste semeia o próprio Admin (endereço sob domínio
// reservado) no banco da execução; os limites por conta, então, não se misturam entre testes.

type Cadastro = {
  endereco: string;
  chave: string;
  codigos: string[];
  codigoDeAtivacao: string;
};

const PASSO = 30_000;

async function lerChave(page: Page): Promise<string> {
  const texto = await page.getByTestId("chave").innerText();
  return texto.replace(/\s/g, "");
}

// Admin novo entra pelo link, vê o cadastro, ativa com o código calculado e guarda os códigos.
async function cadastrarAdmin(page: Page, prefixo = "admin"): Promise<Cadastro> {
  const endereco = emailDeTeste(prefixo);
  await semearAdminParaTeste(endereco);
  await entrarPorLink(page, endereco, "Ative o segundo fator");
  const chave = await lerChave(page);
  const codigoDeAtivacao = gerarTotp(chave);
  await page.getByLabel("Código de 6 dígitos").fill(codigoDeAtivacao);
  await page.getByRole("button", { name: "Ativar" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" })
    .waitFor();
  const codigos = (await page.getByTestId("codigos").locator("li").allInnerTexts()).map((c) =>
    c.trim(),
  );
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await page.getByRole("heading", { level: 1, name: "Administração" }).waitFor();
  return { endereco, chave, codigos, codigoDeAtivacao };
}

// Contexto novo (outro aparelho) que entra de novo pelo link e cai na verificação.
async function novoAparelho(browser: Browser, endereco: string) {
  // O limite de pedidos por endereço (3 em 10 min) é de outro eixo: aqui o que se mede é o segundo fator.
  await liberarLimitesDePedido();
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  try {
    await entrarPorLink(aba, endereco, "Segundo fator");
  } catch (erro) {
    // Diagnóstico: onde a página ficou e o que ela mostra (sem credencial: só a URL sem consulta e o texto).
    const onde = new URL(aba.url()).pathname;
    const texto = (
      await aba
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(0, 300);
    throw new Error(`novoAparelho parou em ${onde}: ${texto}`, { cause: erro });
  }
  return { contexto, aba };
}

test("Admin entra pelo link, é barrado em toda rota, cadastra o autenticador e só então chega à administração", async ({
  page,
  browser,
}) => {
  const endereco = emailDeTeste("admin");
  await semearAdminParaTeste(endereco);
  await entrarPorLink(page, endereco, "Ative o segundo fator");
  await expect(page).toHaveURL(/\/admin\/segundo-fator$/);

  // Antes de verificar: nenhuma página abre.
  for (const rota of ["/trilhas", "/admin", "/"]) {
    await page.goto(rota);
    await expect(page, rota).toHaveURL(/\/admin\/segundo-fator$/);
  }

  // O QR é um ladrilho branco com nome acessível; a chave é lida da tela.
  const ladrilho = page.getByRole("img", { name: "Código QR para o aplicativo autenticador" });
  await expect(ladrilho).toBeVisible();
  const chave = await lerChave(page);
  expect(chave).toMatch(/^[A-Z2-7]{40,64}$/);

  // Código errado não ativa (controle negativo ao lado do positivo).
  const certo = gerarTotp(chave);
  const errado = certo === "000000" ? "000001" : "000000";
  const pedidoDaAcao = page.waitForRequest(
    (r) => r.method() === "POST" && !!r.headers()["next-action"],
  );
  await page.getByLabel("Código de 6 dígitos").fill(errado);
  await page.getByRole("button", { name: "Ativar" }).click();
  const acaoReal = await pedidoDaAcao;
  await expect(page.getByText("Código incorreto.")).toBeVisible();
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/admin\/segundo-fator$/);

  // Recarregar a página mostra a MESMA chave (o aplicativo já escaneado continua valendo).
  expect(await lerChave(page)).toBe(chave);

  await page.getByLabel("Código de 6 dígitos").fill(certo);
  await page.getByRole("button", { name: "Ativar" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" }),
  ).toBeVisible();
  const codigos = await page.getByTestId("codigos").locator("li").allInnerTexts();
  expect(codigos).toHaveLength(10);

  // Sem a caixa marcada, o envio leva o foco a ela e mostra o erro.
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page.getByText("Marque a caixa depois de guardar os códigos.")).toBeVisible();
  await expect(page.getByLabel("Guardei os códigos em um lugar seguro.")).toBeFocused();
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Convites" }).first()).toBeVisible();

  // Depois de verificar, as páginas abrem (controle positivo do bloqueio acima).
  await page.goto("/trilhas");
  await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();

  // Estudante comum: a área não existe (mesma 404), nas duas rotas.
  const estudante = emailDeTeste("estudante");
  await convidarParaTeste(estudante);
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, estudante);
  for (const rota of ["/admin", "/admin/segundo-fator"]) {
    await aba.goto(rota);
    await expect(
      aba.getByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeVisible();
  }
  // POST direto, repetido por um Estudante, à Server Action de ativação capturada acima: a
  // guarda a recusa (a 404) e nenhuma tentativa nem verificação é gravada para a conta dele. O
  // controle positivo (a mesma requisição, com o cookie de um Admin de primeiro fator, é processada)
  // está no teste de POST direto.
  const cab: Record<string, string> = {
    ...acaoReal.headers(),
    origin: new URL(acaoReal.url()).origin,
  };
  delete cab.cookie;
  delete cab["content-length"];
  const corpoDaAcao = acaoReal.postDataBuffer();
  if (!corpoDaAcao) throw new Error("sem corpo da ação");
  await contexto.request.post(new URL(acaoReal.url()).pathname, {
    headers: cab,
    data: corpoDaAcao,
    maxRedirects: 0,
  });
  expect(
    await contar(
      `select count(*) as n from admin.falha_segundo_fator x join auth.session s on s.id = x.session_id join auth."user" u on u.id = s.user_id where u.email = $1`,
      [estudante],
    ),
  ).toBe(0);
  expect(
    await contar(
      `select count(*) as n from admin.sessao_mfa x join auth.session s on s.id = x.session_id join auth."user" u on u.id = s.user_id where u.email = $1`,
      [estudante],
    ),
  ).toBe(0);
  await contexto.close();
  await isolarIp(page);
});

// Um código que não é válido em nenhum dos passos que a biblioteca aceita (anterior, atual, seguinte).
function codigoErrado(chave: string): string {
  const validos = new Set([-1, 0, 1, 2].map((i) => gerarTotp(chave, Date.now() + i * PASSO)));
  for (let n = 0; n < 1000; n++) {
    const c = String(n * 997 + 13)
      .padStart(6, "0")
      .slice(0, 6);
    if (!validos.has(c)) return c;
  }
  throw new Error("sem código errado");
}

async function digitarEConfirmar(page: Page, codigo: string) {
  await page.getByLabel("Código de 6 dígitos").fill(codigo);
  await page.getByRole("button", { name: "Confirmar" }).click();
}

test("entradas seguintes: contexto novo cai na verificação; código certo entra, errado não, e o código já usado não vale de novo", async ({
  page,
  browser,
}) => {
  const a = await cadastrarAdmin(page);
  const { contexto, aba } = await novoAparelho(browser, a.endereco);
  await expect(aba).toHaveURL(/\/admin\/segundo-fator$/);
  await aba.goto("/admin");
  await expect(aba).toHaveURL(/\/admin\/segundo-fator$/);

  // Errado: recusado, com a contagem de tentativas.
  await digitarEConfirmar(aba, codigoErrado(a.chave));
  await expect(aba.getByText("Restam 4 tentativas.")).toBeVisible();
  // O código da ativação ainda está na janela de validade da biblioteca, mas já foi usado:
  // recusado (a biblioteca sozinha o aceitaria).
  await digitarEConfirmar(aba, a.codigoDeAtivacao);
  await expect(aba.getByText("Restam 3 tentativas.")).toBeVisible();
  await aba.goto("/trilhas");
  await expect(aba).toHaveURL(/\/admin\/segundo-fator$/);
  // Controle positivo: o código do passo seguinte, ainda não usado, entra.
  await digitarEConfirmar(aba, gerarTotp(a.chave, Date.now() + PASSO));
  await expect(aba.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
  await aba.goto("/trilhas");
  await expect(aba.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible();
  await contexto.close();
});

test("código de recuperação vale uma vez, e a lista de dez continua valendo para os outros", async ({
  page,
  browser,
}) => {
  const a = await cadastrarAdmin(page);
  const [primeiro, segundo] = a.codigos as [string, string];

  const um = await novoAparelho(browser, a.endereco);
  await um.aba.getByRole("button", { name: "Usar um código de recuperação" }).click();
  // Errado primeiro (controle negativo), depois o certo.
  await um.aba.getByLabel("Código de recuperação").fill("AAAAA-BBBBB");
  await um.aba.getByRole("button", { name: "Confirmar" }).click();
  await expect(um.aba.getByText("Código incorreto.")).toBeVisible();
  await um.aba.getByLabel("Código de recuperação").fill(primeiro);
  await um.aba.getByRole("button", { name: "Confirmar" }).click();
  await expect(um.aba.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();

  // O mesmo código em outro aparelho: recusado. Um código diferente: aceito.
  const dois = await novoAparelho(browser, a.endereco);
  await dois.aba.getByRole("button", { name: "Usar um código de recuperação" }).click();
  await dois.aba.getByLabel("Código de recuperação").fill(primeiro);
  await dois.aba.getByRole("button", { name: "Confirmar" }).click();
  await expect(dois.aba.getByText("Código incorreto.")).toBeVisible();
  await dois.aba.getByLabel("Código de recuperação").fill(segundo);
  await dois.aba.getByRole("button", { name: "Confirmar" }).click();
  await expect(dois.aba.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
  await um.contexto.close();
  await dois.contexto.close();
});

test("cinco códigos errados na mesma sessão encerram a sessão e levam a /entrar", async ({
  page,
  browser,
}) => {
  const a = await cadastrarAdmin(page);
  const { contexto, aba } = await novoAparelho(browser, a.endereco);
  const antes = await sessoesDe(a.endereco);
  for (const restantes of [4, 3, 2, 1]) {
    await digitarEConfirmar(aba, codigoErrado(a.chave));
    await expect(
      aba.getByText(restantes === 1 ? "Resta 1 tentativa." : `Restam ${restantes} tentativas.`),
    ).toBeVisible();
  }
  await digitarEConfirmar(aba, codigoErrado(a.chave));
  await expect(aba).toHaveURL(/\/entrar\?motivo=segundo-fator$/);
  await expect(
    aba.getByText("Muitas tentativas erradas. Sua sessão foi encerrada. Entre de novo."),
  ).toBeVisible();
  expect(await sessoesDe(a.endereco)).toBe(antes - 1);
  await aba.goto("/admin/segundo-fator");
  await expect(aba).toHaveURL(/\/entrar\?motivo=sessao/);
  // Controle: a primeira sessão (a que cadastrou) segue valendo, e uma entrada nova com o código
  // certo ainda funciona (o limite é da sessão, não bloqueou a conta).
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
  const nova = await novoAparelho(browser, a.endereco);
  await digitarEConfirmar(nova.aba, gerarTotp(a.chave, Date.now() + PASSO));
  await expect(nova.aba.getByRole("heading", { level: 1, name: "Administração" })).toBeVisible();
  await nova.contexto.close();
  await contexto.close();
});

test("teto por conta: sessões novas não ganham palpites novos sem fim", async ({
  page,
  browser,
}) => {
  const a = await cadastrarAdmin(page);
  // O contador de conta (10 por hora, janela ancorada no primeiro evento) já está em 9: o
  // comportamento do contador em si é medido no teste de integração; aqui se mede o que o fluxo faz
  // com ele. Semeado no banco da execução, com o mesmo resumo de chave que o código usa.
  const id = await idDoUsuario(a.endereco);
  const chave = `segundo-fator-conta:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
  await escrever(
    "insert into admin.tentativa (chave, janela_inicio, contagem) values ($1, now(), 9) on conflict (chave) do update set contagem = 9, janela_inicio = now()",
    [chave],
  );
  const { contexto, aba } = await novoAparelho(browser, a.endereco);
  await digitarEConfirmar(aba, codigoErrado(a.chave)); // a 10ª: ainda compara
  await expect(aba.getByText("Restam 4 tentativas.")).toBeVisible();
  // A 11ª, mesmo com o código CERTO, não chega a comparar: sessão encerrada.
  await digitarEConfirmar(aba, gerarTotp(a.chave, Date.now() + PASSO));
  await expect(aba).toHaveURL(/\/entrar\?motivo=segundo-fator$/);
  await aba.goto("/admin");
  await expect(aba).toHaveURL(/\/entrar\?motivo=sessao/);
  await contexto.close();
});

test("recuperação pelo dono do banco: tudo do segundo fator antigo morre e a próxima entrada recadastra", async ({
  page,
  browser,
}) => {
  const a = await cadastrarAdmin(page);
  const saida = await recuperarSegundoFatorParaTeste(a.endereco);
  expect(saida).toContain("sessões encerradas: 1");
  expect(saida).not.toContain(a.endereco);
  expect(await sessoesDe(a.endereco)).toBe(0);
  // A sessão que estava verificada acabou.
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
  // A próxima entrada exige novo cadastro, com chave diferente.
  const contexto = await browser.newContext();
  const aba = await contexto.newPage();
  await entrarPorLink(aba, a.endereco, "Ative o segundo fator");
  const nova = await lerChave(aba);
  expect(nova).not.toBe(a.chave);
  // O código da chave antiga não ativa; o da nova ativa (controle positivo).
  await aba.getByLabel("Código de 6 dígitos").fill(gerarTotp(a.chave, Date.now() + PASSO));
  await aba.getByRole("button", { name: "Ativar" }).click();
  await expect(aba.getByText("Código incorreto.")).toBeVisible();
  await aba.getByLabel("Código de 6 dígitos").fill(gerarTotp(nova));
  await aba.getByRole("button", { name: "Ativar" }).click();
  await expect(
    aba.getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" }),
  ).toBeVisible();
  const novos = await aba.getByTestId("codigos").locator("li").allInnerTexts();
  expect(novos.some((c) => a.codigos.includes(c.trim()))).toBe(false);
  await contexto.close();
  // Um código de recuperação do conjunto antigo não vale no novo.
  const verificando = await novoAparelho(browser, a.endereco);
  await verificando.aba.getByRole("button", { name: "Usar um código de recuperação" }).click();
  await verificando.aba.getByLabel("Código de recuperação").fill(a.codigos[0] as string);
  await verificando.aba.getByRole("button", { name: "Confirmar" }).click();
  await expect(verificando.aba.getByText("Código incorreto.")).toBeVisible();
  await verificando.contexto.close();
});

// Todas as páginas e rotas do app, lidas do disco: nenhuma abre só com o primeiro fator.
const PUBLICAS = new Set([
  "/",
  "/entrar",
  "/entrar/confirmar",
  "/casca-teste",
  "/api/ambiente",
  "/api/auth/[...all]",
]);
const ISENTAS = new Set(["/admin/segundo-fator"]);

function rotasDoApp(): string[] {
  const raiz = join(process.cwd(), "src", "app");
  const achadas: string[] = [];
  const andar = (dir: string) => {
    for (const nome of readdirSync(dir)) {
      const caminho = join(dir, nome);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (/^(page|route)\.tsx?$/.test(nome)) {
        const segmentos = relative(raiz, dir)
          .split("/")
          .filter((x) => x !== "" && !/^\(.*\)$/.test(x));
        achadas.push(`/${segmentos.join("/")}`);
      }
    }
  };
  andar(raiz);
  return achadas;
}

test("a lista de rotas lida do disco: nenhuma abre só com o primeiro fator; as rotas da biblioteca respondem 404", async ({
  page,
  browser,
}) => {
  const rotas = rotasDoApp();
  expect(rotas).toEqual(expect.arrayContaining(["/trilhas", "/admin", "/admin/segundo-fator"]));
  const protegidas = rotas.filter((r) => !PUBLICAS.has(r) && !ISENTAS.has(r));
  expect(protegidas).toEqual(expect.arrayContaining(["/trilhas", "/admin"]));
  // Rota nova com parâmetro na URL precisa de teste próprio: falha em vez de passar calada.
  expect(protegidas.filter((r) => r.includes("["))).toEqual([]);

  const a = await cadastrarAdmin(page);
  const { contexto, aba } = await novoAparelho(browser, a.endereco);
  for (const rota of protegidas) {
    await aba.goto(rota);
    await expect(aba, rota).toHaveURL(/\/admin\/segundo-fator$/);
  }
  // Controle positivo: com a sessão verificada, as mesmas rotas abrem.
  for (const rota of protegidas) {
    await page.goto(rota);
    await expect(page, rota).not.toHaveURL(/segundo-fator|entrar/);
  }

  // As rotas da biblioteca: 404 para quem tem só o primeiro fator (e para a sessão verificada).
  const origem = new URL(test.info().project.use.baseURL ?? "http://localhost").origin;
  const cruas = [
    "two-factor/enable",
    "two-factor/disable",
    "two-factor/generate-backup-codes",
    "two-factor/get-totp-uri",
    "two-factor/verify-totp",
    "two-factor/verify-backup-code",
    "two-factor/view-backup-codes",
    "two-factor/send-otp",
    "totp/generate",
  ];
  for (const contextoDeTeste of [contexto, page.context()]) {
    for (const c of cruas) {
      const r = await contextoDeTeste.request.post(`/api/auth/${c}`, {
        data: { code: "000000", userId: "x" },
        headers: { origin: origem },
      });
      expect(r.status(), c).toBe(404);
    }
    // Controle: a leitura da própria sessão segue funcionando.
    expect((await contextoDeTeste.request.get("/api/auth/get-session")).status()).toBe(200);
  }
  await contexto.close();
});

test("POST direto à Server Action de verificação: sem sessão, nada é processado", async ({
  page,
  browser,
}) => {
  const a = await cadastrarAdmin(page);
  const { contexto, aba } = await novoAparelho(browser, a.endereco);
  const origem = new URL(test.info().project.use.baseURL ?? "http://localhost").origin;

  // Captura a requisição real da ação (um código errado do próprio Admin de primeiro fator).
  const pedido = aba.waitForRequest((r) => r.method() === "POST" && !!r.headers()["next-action"]);
  await digitarEConfirmar(aba, codigoErrado(a.chave));
  const real = await pedido;
  await expect(aba.getByText("Restam 4 tentativas.")).toBeVisible();
  const cabecalhos: Record<string, string> = { ...real.headers(), origin: origem };
  delete cabecalhos.cookie;
  delete cabecalhos["content-length"];
  const corpo = real.postDataBuffer();
  if (!corpo) throw new Error("sem corpo da ação");
  const caminho = new URL(real.url()).pathname;
  // Só as linhas da conta deste teste (os outros testes rodam em paralelo no mesmo banco).
  const dono = `join auth.session s on s.id = x.session_id join auth."user" u on u.id = s.user_id where u.email = any($1)`;
  const verificadas = () =>
    contar(`select count(*) as n from admin.sessao_mfa x ${dono}`, [`{${a.endereco}}`]);
  const gastas = () =>
    contar(`select coalesce(sum(x.falhas), 0) as n from admin.falha_segundo_fator x ${dono}`, [
      `{${a.endereco}}`,
    ]);
  const antesVerificadas = await verificadas();
  const antesGastas = await gastas();

  // (1) Sem cookie algum.
  const anonimo = await browser.newContext();
  await anonimo.request.post(caminho, { headers: cabecalhos, data: corpo, maxRedirects: 0 });
  expect(await verificadas()).toBe(antesVerificadas);
  expect(await gastas()).toBe(antesGastas);

  // Controle positivo: o MESMO corpo reenviado com o cookie do Admin é processado (gasta uma
  // tentativa), então a ausência de efeito acima vem da guarda e não de um corpo malformado.
  await contexto.request.post(caminho, { headers: cabecalhos, data: corpo, maxRedirects: 0 });
  expect(await gastas()).toBe(antesGastas + 1);
  expect(await verificadas()).toBe(antesVerificadas);
  await anonimo.close();
  await contexto.close();
});
