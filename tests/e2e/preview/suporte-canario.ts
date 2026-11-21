import { createHmac, randomBytes } from "node:crypto";
import { type Browser, type BrowserContext, expect, type Page } from "@playwright/test";
import pg from "pg";
import {
  desabilitar,
  habilitar,
  lerEstado,
  type Papel,
  VARIAVEL_DO_PAPEL,
} from "../../../scripts/dev/canario";
import { obterPool } from "../../../src/db/cliente";
import { lerEmail } from "../../../src/modules/identidade/normalizar-email";
import { esperarHidratado } from "../../support/hidratacao";
import { gerarTotp } from "../../support/totp";

// Suporte dos testes de pré-visualização com contas canário (plano 01-19). Todo endereço e todo segredo
// vêm do ambiente do processo, por nome (variáveis do ambiente dev injetadas no processo, nunca em arquivo); nada
// disto imprime endereço, token nem cookie.
//
// A sessão é criada pelo próprio teste no banco de desenvolvimento (a pré-visualização aponta para ele)
// e assinada com o segredo da biblioteca de entrada, como a entrada real faz: assim nenhum e-mail sai.
// A entrada por e-mail e por código tem prova própria (fumaça, `convidado.spec.ts` e a entrada do dono).

export const PAPEIS: Papel[] = ["estudante", "admin"];

function exigir(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`INDETERMINADO: falta ${nome} no ambiente`);
  return valor;
}

export function emailDo(papel: Papel): string {
  const email = lerEmail(process.env[VARIAVEL_DO_PAPEL[papel]]);
  if (!email) throw new Error(`INDETERMINADO: ${VARIAVEL_DO_PAPEL[papel]} ausente ou inválida`);
  return email;
}

// O Admin real (ADMIN_EMAIL_INICIAL) nunca é tocado: se um canário apontar para ele, nada roda.
export function recusarSeForOAdminReal(): void {
  const real = lerEmail(process.env.ADMIN_EMAIL_INICIAL);
  for (const papel of PAPEIS) {
    if (real && emailDo(papel) === real) {
      throw new Error(`RECUSA: o canário ${papel} é o Admin real; nada foi alterado`);
    }
  }
}

export async function habilitarCanarios(papeis: Papel[]): Promise<void> {
  recusarSeForOAdminReal();
  const pool = obterPool();
  for (const papel of papeis) {
    const { estado } = await habilitar(pool, emailDo(papel), papel, false);
    if (!estado.entradaPermitida) throw new Error(`o canário ${papel} não ficou habilitado`);
  }
}

// Desabilita e MEDE (convite revogado, zero sessões, sessão anterior recusada, zero segundo fator).
// Também roda depois de falha: é o `afterAll` do arquivo.
export async function desabilitarCanarios(papeis: Papel[]): Promise<void> {
  const pool = obterPool();
  const falhas: string[] = [];
  for (const papel of papeis) {
    await apagarDadosPrivados(papel);
    const r = await desabilitar(pool, emailDo(papel));
    const e = await lerEstado(pool, emailDo(papel));
    if (!r.confirmado || e.sessoes !== 0 || e.entradaPermitida) falhas.push(papel);
  }
  if (falhas.length > 0)
    throw new Error(`canário NÃO confirmado desabilitado: ${falhas.join(", ")}`);
}

// Apaga o que o teste escreveu na conta canário (só dela): as tabelas privadas com `estudante_id`.
// O consentimento sai também, para a próxima rodada partir sem aceite.
export async function apagarDadosPrivados(papel: Papel): Promise<void> {
  const c = new pg.Client({ connectionString: exigir("DATABASE_URL_OWNER") });
  await c.connect();
  try {
    const u = await c.query<{ id: string }>('select id from auth."user" where email = $1', [
      emailDo(papel),
    ]);
    const id = u.rows[0]?.id;
    if (!id) return;
    const tabelas = await c.query<{ table_name: string }>(
      `select table_name from information_schema.columns
       where table_schema = 'privado' and column_name = 'estudante_id' order by table_name`,
    );
    // Tabelas filhas primeiro: o escritor da Anotação aponta para a Anotação.
    const ordem = [...tabelas.rows.map((r) => r.table_name)].sort((a, b) =>
      a.endsWith("_escritor") ? -1 : b.endsWith("_escritor") ? 1 : a.localeCompare(b),
    );
    for (const tabela of ordem) {
      await c.query(
        `delete from privado.${tabela.replace(/[^a-z_]/g, "")} where estudante_id = $1`,
        [id],
      );
    }
  } finally {
    await c.end();
  }
}

export type SessaoCanario = {
  contexto: BrowserContext;
  id: string;
  usuarioId: string;
  encerrar: () => Promise<void>;
};

// Cria UMA sessão de 30 minutos para o canário e devolve um contexto de navegador que a carrega.
export async function abrirSessao(
  browser: Browser,
  papel: Papel,
  baseURL: string,
  viewport = { width: 390, height: 844 },
): Promise<SessaoCanario> {
  const segredo = exigir("BETTER_AUTH_SECRET");
  const bypass = exigir("VERCEL_AUTOMATION_BYPASS_SECRET");
  const db = new pg.Client({ connectionString: exigir("DATABASE_URL_OWNER") });
  await db.connect();
  const u = await db.query<{ id: string }>('select id from auth."user" where email = $1', [
    emailDo(papel),
  ]);
  if (u.rowCount !== 1) {
    await db.end();
    throw new Error(`INDETERMINADO: conta canário ${papel} não encontrada`);
  }
  const usuarioId = u.rows[0]?.id as string;
  const token = randomBytes(32).toString("base64url");
  const s = await db.query<{ id: string }>(
    "insert into auth.session (user_id, token, expires_at) values ($1, $2, now() + interval '30 minutes') returning id",
    [usuarioId, token],
  );
  const id = s.rows[0]?.id as string;
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
      await db.query("delete from auth.session where id = $1", [id]).catch(() => undefined);
      await db.end().catch(() => undefined);
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
