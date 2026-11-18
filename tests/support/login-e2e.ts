import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { ultimoEmailPara } from "./caixa-de-email";

const executar = promisify(execFile);

// Endereço único por teste, sob domínio reservado.
export function emailDeTeste(prefixo = "estudante"): string {
  return `${prefixo}-${randomBytes(5).toString("hex")}@convite.example`;
}

// Convida pelo comando de verdade, no banco da execução. O endereço vai por variável de ambiente.
export async function convidarParaTeste(endereco: string): Promise<void> {
  await executar(
    "pnpm",
    ["exec", "tsx", "scripts/admin/convidar.ts", "--variavel", "JNF_EMAIL_TESTE"],
    {
      env: { ...process.env, JNF_EMAIL_TESTE: endereco },
    },
  );
}

// Cada contexto tem o seu IP de teste: os limites por IP não podem ligar testes paralelos.
export async function isolarIp(page: Page): Promise<void> {
  const [a, b, c] = [1, 2, 3].map(() => 1 + Math.floor(Math.random() * 250));
  await page.context().setExtraHTTPHeaders({ "x-real-ip": `10.${a}.${b}.${c}` });
}

export async function pedirAcesso(page: Page, endereco: string): Promise<void> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(endereco);
  await page.getByRole("button", { name: "Enviar acesso" }).click();
  await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
}

export async function entrarPorLink(page: Page, endereco: string): Promise<void> {
  await isolarIp(page);
  await pedirAcesso(page, endereco);
  const { link } = await ultimoEmailPara(endereco);
  if (!link) throw new Error("O e-mail não trouxe o link");
  await page.goto(link);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Trilhas" }).waitFor();
}
