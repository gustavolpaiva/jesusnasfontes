import { createHmac } from "node:crypto";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import pg from "pg";
import type { Papel } from "../../../scripts/dev/canario";
import { ExecucaoCanario } from "../../../scripts/dev/execucao-canario";
import { obterPool } from "../../../src/db/cliente";
import { esperarHidratado } from "../../support/hidratacao";
import { gerarTotp } from "../../support/totp";

// Suporte dos testes de pré-visualização com contas canário (plano 01-19). Todo endereço e todo segredo
// vêm do ambiente do processo, por nome (variáveis do ambiente dev injetadas no processo, nunca em arquivo); nada
// disto imprime endereço, token nem cookie.
//
// A sessão é criada pelo próprio teste no banco de desenvolvimento (a pré-visualização aponta para ele)
// e assinada com o segredo da biblioteca de entrada, como a entrada real faz: assim nenhum e-mail sai.
// A entrada por e-mail e por código tem prova própria (fumaça, `convidado.spec.ts` e a entrada do dono).
//
// Tudo que escreve passa por `ExecucaoCanario` (scripts/dev/execucao-canario.ts): marca própria da
// execução, uma execução por conta canário de cada vez (trava), conta que começa sem linha privada,
// proteção contra conta real no começo e no fim, marcador `dev` conferido em toda conexão que escreve, e
// limpeza de todas as linhas privadas da conta (que são desta execução por construção), com teto.

export const PAPEIS: Papel[] = ["estudante", "admin"];

function exigir(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`INDETERMINADO: falta ${nome} no ambiente`);
  return valor;
}

// Uma execução NOVA por suíte (arquivo de teste), criada no `beforeAll` com marca nova: a instância é de uso
// único (o `afterAll` a encerra), e o Playwright preserva o cache de módulos entre arquivos do mesmo worker.
export function novaExecucao(): ExecucaoCanario {
  return new ExecucaoCanario({
    pool: () => obterPool(),
    dono: async () => {
      const cliente = new pg.Client({ connectionString: exigir("DATABASE_URL_OWNER") });
      await cliente.connect();
      return { cliente, fechar: () => cliente.end() };
    },
    // A trava mora numa conexão própria, direta e aberta até o fim da execução.
    trava: async () => {
      const cliente = new pg.Client({ connectionString: exigir("DATABASE_URL_OWNER") });
      await cliente.connect();
      return { cliente, fechar: () => cliente.end() };
    },
  });
}

export type SessaoCanario = {
  contexto: BrowserContext;
  id: string;
  usuarioId: string;
  encerrar: () => Promise<void>;
};

// Cria UMA sessão de 30 minutos para o canário e devolve um contexto de navegador que a carrega.
export async function abrirSessao(
  execucao: ExecucaoCanario,
  browser: Browser,
  papel: Papel,
  baseURL: string,
  viewport = { width: 390, height: 844 },
): Promise<SessaoCanario> {
  const segredo = exigir("BETTER_AUTH_SECRET");
  const bypass = exigir("VERCEL_AUTOMATION_BYPASS_SECRET");
  const { id, usuarioId, token } = await execucao.criarSessao(papel);
  const assinado = createHmac("sha256", segredo).update(token).digest("base64");
  const valor = encodeURIComponent(`${token}.${assinado}`);
  const host = new URL(baseURL).hostname;
  const contexto = await browser.newContext({
    baseURL,
    viewport,
    extraHTTPHeaders: { "x-vercel-protection-bypass": bypass },
  });
  await contexto.addCookies(
    ["__Secure-better-auth.session_token", "better-auth.session_token"].map((name) => ({
      name,
      value: valor,
      domain: host,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax" as const,
    })),
  );
  return {
    contexto,
    id,
    usuarioId,
    encerrar: async () => {
      await contexto.close().catch(() => undefined);
      await execucao.encerrarSessao(id);
    },
  };
}

// Aceita o aviso de privacidade pela tela, como a pessoa faz.
export async function aceitarAviso(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/privacidade\/aceitar/);
  const caixa = page.getByRole("checkbox");
  await caixa.waitFor({ state: "visible" });
  await page.waitForLoadState("load");
  await esperarHidratado(caixa);
  await caixa.check();
  await page.getByRole("button", { name: "Concordar e continuar", exact: true }).click();
  // A ação redireciona: sem esperar, a próxima navegação do teste disputa com a do servidor.
  await expect(page).not.toHaveURL(/\/privacidade\/aceitar/, { timeout: 30_000 });
}

// Cadastra o segundo fator do Admin canário pela tela, com o código calculado da chave que ela mostra.
export async function cadastrarSegundoFator(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { level: 1, name: "Ative o segundo fator" }),
  ).toBeVisible();
  const chave = (await page.getByTestId("chave").innerText()).replace(/\s/g, "");
  await esperarHidratado(page.getByRole("button", { name: "Ativar" }));
  await page.getByLabel("Código de 6 dígitos").fill(gerarTotp(chave));
  await page.getByRole("button", { name: "Ativar" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Guarde seus códigos de recuperação" }),
  ).toBeVisible();
  await page.getByLabel("Guardei os códigos em um lugar seguro.").click();
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page).not.toHaveURL(/\/admin\/segundo-fator/, { timeout: 30_000 });
}

// Leva o Admin canário até a Administração: aviso de privacidade (se pedido) e segundo fator (se pedido).
export async function prepararAdmin(page: Page): Promise<void> {
  const convites = page.getByRole("heading", { level: 1, name: "Convites" });
  const ativar = page.getByRole("heading", { level: 1, name: "Ative o segundo fator" });
  const aviso = page.getByRole("heading", { level: 1, name: "Antes de começar" });
  // A ordem das barreiras é do produto (segundo fator e aviso); a cada volta resolve a que aparecer.
  for (let volta = 0; volta < 4; volta++) {
    await page.goto("/admin/convites");
    await expect(convites.or(ativar).or(aviso)).toBeVisible({ timeout: 30_000 });
    if (await convites.isVisible()) return;
    if (await aviso.isVisible()) await aceitarAviso(page);
    else await cadastrarSegundoFator(page);
  }
  await expect(convites).toBeVisible();
}

// Escreve numa Anotação do Estudo e espera o "Salvo" do servidor.
export async function escreverAnotacao(page: Page, slug: string, texto: string): Promise<void> {
  await page.goto(`/estudos/${slug}`);
  const campo = page.getByRole("textbox", { name: "Minha anotação" });
  await esperarHidratado(campo);
  await campo.fill(texto);
  await expect(page.locator('[data-slot="save-status"]')).toHaveText("Salvo", { timeout: 20_000 });
}
