import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// Braço CONVIDADO do SP-2, com a conta canário: cada pedido do canário ENVIA UM E-MAIL DE VERDADE
// (3 no total). Por isso a tag @envia-email-real: o projeto `preview` só o inclui com
// JNF_PREVIEW_ENVIA_EMAIL_REAL=1, e ele tem de ser rodado sob decisão de quem é dono da caixa, com o
// canário habilitado antes e desabilitado depois. O limite do produto é de 3 pedidos por endereço em
// 10 minutos: não rode nada que peça acesso para o canário nos 10 minutos antes ou durante.
//
//   JNF_PREVIEW_ENVIA_EMAIL_REAL=1 PREVIEW_URL=<url> <variáveis do ambiente de desenvolvimento> \
//     pnpm exec playwright test --project=preview --grep @envia-email-real
//
// O endereço do canário é lido da variável JNF_CANARIO_ESTUDANTE_EMAIL, por nome; nunca é impresso.
// Pareia cada pedido do canário com um de endereço NÃO convidado, alternando quem vai primeiro.

const PARES = 3;
const ESPACO_MS = 13_000; // 5 pedidos por IP por minuto: um pedido a cada 13 s fica abaixo

async function pedir(page: Page, alvo: string): Promise<number> {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(alvo);
  const [resposta] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/entrar")),
    page.getByRole("button", { name: "Enviar acesso" }).click(),
  ]);
  await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
  const t = resposta.request().timing();
  return t.responseEnd - t.requestStart;
}

test("pares convidado e não convidado contra a pré-visualização", {
  tag: "@envia-email-real",
}, async ({ page }) => {
  test.setTimeout(180_000 + PARES * 2 * (ESPACO_MS + 8_000));
  const canario = process.env.JNF_CANARIO_ESTUDANTE_EMAIL;
  expect(canario, "JNF_CANARIO_ESTUDANTE_EMAIL precisa estar no ambiente").toBeTruthy();
  await page.waitForTimeout(61_000); // a janela do limite por IP começa limpa
  const convidado: number[] = [];
  const naoConvidado: number[] = [];
  for (let i = 0; i < PARES; i++) {
    const outro = `fumaca-${randomBytes(5).toString("hex")}@convite.example`;
    const primeiroConvidado = i % 2 === 0;
    const a = await pedir(page, primeiroConvidado ? (canario as string) : outro);
    await page.waitForTimeout(ESPACO_MS);
    const b = await pedir(page, primeiroConvidado ? outro : (canario as string));
    await page.waitForTimeout(ESPACO_MS);
    convidado.push(primeiroConvidado ? a : b);
    naoConvidado.push(primeiroConvidado ? b : a);
  }
  const diferencas = convidado.map((c, i) => c - (naoConvidado[i] as number));
  const mediana = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] as number;
  const resultado = {
    pares: PARES,
    convidado_ms: convidado.map(Math.round),
    nao_convidado_ms: naoConvidado.map(Math.round),
    diferencas_ms: diferencas.map(Math.round),
    mediana_da_diferenca_ms: Math.round(mediana(diferencas)),
    emails_reais_enviados: PARES,
    medido_em: new Date().toISOString(),
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/sp2-convidado-preview.json", JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado));
  expect(convidado).toHaveLength(PARES);
});
