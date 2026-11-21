import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import type { ExecucaoCanario } from "../../../scripts/dev/execucao-canario";
import { esperarHidratado } from "../../support/hidratacao";
import {
  abrirSessao,
  aceitarAviso,
  escreverAnotacao,
  novaExecucao,
  PAPEIS,
  prepararAdmin,
} from "./suporte-canario";

// Percurso real da fase inteira numa pré-visualização implantada (plano 01-19, Tarefa 1):
//
//   PREVIEW_URL=<url> <executor com as variáveis do ambiente dev no processo> \
//     pnpm exec playwright test --project=preview tests/e2e/preview/uat.spec.ts
//
// Contas canário (uma por papel): habilitadas no início e desabilitadas no fim, também quando um passo
// falha (`afterAll`). Nenhum e-mail sai. O texto-marcador escrito pela interface fica em
// `test-results/marcador-uat.txt` para `operacao/procurar-marcador-vercel.sh` procurá-lo nos registros.
//
// Não exercido aqui: entrada por e-mail e por código (a sessão é criada pelo teste no banco de dev),
// WebKit, aparelho real, voz real, VoiceOver, apagar conta.

test.describe.configure({ mode: "serial" });

// A execução e a marca nascem no `beforeAll` (instância de uso único, uma por suíte).
let execucao: ExecucaoCanario;
let MARCADOR = "";
const ESTUDO = "nicodemos-nascer-de-novo";
const TITULO = "Nicodemos: nascer de novo";
const CAPTURAS = "test-results/preview-uat";

test.beforeAll(async () => {
  mkdirSync(CAPTURAS, { recursive: true });
  execucao = novaExecucao();
  await execucao.preparar(PAPEIS);
  MARCADOR = `MARCADOR-${execucao.marca}`;
  writeFileSync("test-results/marcador-uat.txt", `${MARCADOR}\n`, { mode: 0o600 });
});

test.afterAll(async () => {
  await execucao?.finalizar();
});

async function clicarQuandoHidratado(page: Page, nome: string | RegExp): Promise<void> {
  const botao = page.getByRole("button", { name: nome });
  await esperarHidratado(botao);
  await botao.click();
}

test("Estudante canário: aviso, Trilhas 8/30/89, Estudo com Afirmação e Divergência, Ouvir, Anotação, Sessão, Caderno, exportar e Sair", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(300_000);
  const s = await abrirSessao(execucao, browser, "estudante", baseURL as string);
  try {
    const page = await s.contexto.newPage();

    await test.step("sem aceite, /trilhas leva ao aviso; aceitar pela tela leva às Trilhas", async () => {
      await page.goto("/trilhas");
      await expect(page).toHaveURL(/\/privacidade\/aceitar/);
      await aceitarAviso(page);
      await expect(page.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible({
        timeout: 30_000,
      });
    });

    await test.step("as três Trilhas têm 8, 30 e 89 Estudos, sem rolagem horizontal", async () => {
      const filetes = page.getByRole("progressbar");
      await expect(filetes).toHaveCount(3);
      const totais = (
        await filetes.evaluateAll((els) => els.map((e) => Number(e.getAttribute("aria-valuemax"))))
      ).sort((a, b) => a - b);
      expect(totais).toEqual([8, 30, 89]);
      const sobra = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sobra).toBeLessThanOrEqual(0);
      await page.screenshot({ path: `${CAPTURAS}/01-trilhas-390.png` });
    });

    await test.step("abre um Estudo pelas Trilhas", async () => {
      await page.getByRole("button", { name: /Base histórica/ }).click();
      await page
        .getByRole("link", { name: /O que a história consegue afirmar/ })
        .first()
        .click();
      await expect(page).toHaveURL(/\/estudos\//, { timeout: 30_000 });
      await expect(page.getByText("Fonte em preparação").first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step("Estudo com Afirmação e Divergência entre tradições", async () => {
      await page.goto(`/estudos/${ESTUDO}`);
      await expect(page.getByRole("heading", { level: 1, name: TITULO })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('[data-afirmacao-id="pc17-a1"]')).toBeVisible();
      await expect(page.locator('[data-slot="chip-fonte"]').first()).toHaveText(
        "Fonte em preparação",
      );
      const divergencia = page.getByRole("region", { name: "Divergência entre tradições" });
      await expect(divergencia).toBeVisible();
      await page.screenshot({ path: `${CAPTURAS}/02-estudo-390.png`, fullPage: true });
    });

    await test.step("Ouvir: sem voz em português mostra a mensagem de indisponibilidade; com voz, começa a ler", async () => {
      const controle = page.locator('[data-ouvir="estudo"]');
      const principal = controle.locator("button").first();
      await esperarHidratado(principal);
      const semVoz = controle.getByText(
        /Seu aparelho não tem voz em português|Este navegador não lê/,
      );
      // Primeiro o estado: o botão sem voz é `aria-disabled` e clicar nele não prova nada. Espera sair de
      // "procurando voz" para "mensagem de sem voz" ou "pronto".
      await expect
        .poll(
          async () =>
            (await semVoz.isVisible())
              ? "sem-voz"
              : (await principal.getAttribute("aria-disabled")) === "true"
                ? "procurando"
                : "pronto",
          { timeout: 10_000 },
        )
        .not.toBe("procurando");
      if (await semVoz.isVisible()) {
        // Ramo 1 (PASSOU): sem voz, a mensagem de indisponibilidade é o resultado esperado.
        await expect(principal).toHaveAttribute("aria-disabled", "true");
        console.log(
          "ouvir | ramo sem voz: mensagem de indisponibilidade mostrada, botão desabilitado",
        );
      } else {
        // Ramo 2 (PASSOU): há voz, o clique começa a ler.
        await principal.click();
        await expect(principal.filter({ hasText: "Pausar" })).toBeVisible({ timeout: 10_000 });
        console.log("ouvir | ramo com voz do navegador: começou a ler");
        await principal.click();
      }
    });

    await test.step("check-in no Estudo", async () => {
      await clicarQuandoHidratado(page, /Fazer check-in no Estudo/);
      await expect(page.locator('[data-slot="sessao-bar"]')).toContainText(
        /Sessão aberta desde \d{2}:\d{2}/,
        { timeout: 20_000 },
      );
    });

    await test.step("Anotação com o marcador, salva no servidor", async () => {
      await escreverAnotacao(page, ESTUDO, `${MARCADOR} escrito pelo ensaio`);
      await page.screenshot({ path: `${CAPTURAS}/03-anotacao-390.png`, fullPage: true });
    });

    await test.step("check-out com Anotação da Sessão", async () => {
      await page.goto(`/estudos/${ESTUDO}`);
      await clicarQuandoHidratado(page, "Fazer check-out");
      const folha = page.getByRole("dialog", { name: "Encerrar a Sessão" });
      await expect(folha).toBeVisible();
      await folha.getByLabel("Anotação da Sessão (opcional)").fill(`${MARCADOR} da sessão`);
      await folha.getByRole("button", { name: "Encerrar Sessão" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: /Sessão encerrada: \d+ min/ }),
      ).toBeVisible({ timeout: 20_000 });
    });

    await test.step("busca o marcador no Caderno: acha a Anotação e a Anotação da Sessão; o termo não vai à URL", async () => {
      await page.goto("/caderno");
      await expect(page.getByRole("heading", { level: 1, name: "Caderno" })).toBeVisible();
      const buscar = page.getByRole("button", { name: "Buscar", exact: true });
      await esperarHidratado(buscar);
      const antes = page.url();
      await page.getByRole("searchbox", { name: "Buscar nas Anotações" }).fill(MARCADOR);
      await buscar.click();
      await expect(page.locator('[data-slot="entrada-caderno"]')).toHaveCount(2, {
        timeout: 20_000,
      });
      expect(page.url()).toBe(antes);
      await page.screenshot({ path: `${CAPTURAS}/04-caderno-390.png`, fullPage: true });
    });

    await test.step("baixa os dados: chaves do arquivo, o marcador e só a própria conta", async () => {
      await page.goto("/conta");
      const botao = page.getByRole("button", { name: "Baixar meus dados" });
      await expect(botao).toBeVisible();
      await esperarHidratado(botao);
      const [download] = await Promise.all([page.waitForEvent("download"), botao.click()]);
      expect(download.suggestedFilename()).toBe("jesus-nas-fontes-meus-dados.json");
      const bruto = readFileSync((await download.path()) as string, "utf8");
      const dados = JSON.parse(bruto) as {
        versaoFormato: number;
        perfil: { email: string };
        tabelas: Record<string, unknown[]>;
      };
      expect(Object.keys(dados)).toEqual(
        expect.arrayContaining(["geradoEm", "versaoFormato", "perfil", "convite", "tabelas"]),
      );
      expect(Object.keys(dados.tabelas)).toEqual(
        expect.arrayContaining([
          "anotacao",
          "consentimento",
          "posicao",
          "conclusao",
          "volta_leitura",
        ]),
      );
      expect(dados.tabelas.consentimento).toHaveLength(1);
      expect(bruto).toContain(MARCADOR);
    });

    await test.step("Sair leva a /entrar e apaga a sessão no banco", async () => {
      await page.getByRole("button", { name: "Abrir menu" }).click();
      await page.getByRole("button", { name: "Sair", exact: true }).click();
      await expect(page).toHaveURL(/\/entrar/, { timeout: 30_000 });
      const db = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
      await db.connect();
      try {
        const r = await db.query("select count(*)::int n from auth.session where id = $1", [s.id]);
        expect(r.rows[0].n).toBe(0);
      } finally {
        await db.end();
      }
    });
  } finally {
    await s.encerrar();
  }
});

test("Admin canário: aviso, segundo fator cadastrado pela tela e a lista de convites", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const s = await abrirSessao(execucao, browser, "admin", baseURL as string, {
    width: 1280,
    height: 800,
  });
  try {
    const page = await s.contexto.newPage();
    await prepararAdmin(page);
    await expect(
      page.getByRole("heading", { level: 2, name: /^Convidados \(\d+\)$/ }),
    ).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Pendente" }).first()).toBeVisible();
    await page.screenshot({ path: `${CAPTURAS}/05-admin-convites-1280.png` });
  } finally {
    await s.encerrar();
  }
});
