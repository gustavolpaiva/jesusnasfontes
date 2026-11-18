import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emailsPara, ultimoEmailPara } from "../../support/caixa-de-email";
import {
  convidarParaTeste,
  convidarVarios,
  emailDeTeste,
  isolarIp,
  linhasDe,
} from "../../support/login-e2e";

// Troca o endereço digitado por um marcador: o eco do digitado é a única diferença legítima.
async function telaDaEtapa2(page: import("@playwright/test").Page, endereco: string) {
  const html = await page.locator("main").innerHTML();
  return html.split(endereco).join("[EMAIL]");
}

async function pedir(page: import("@playwright/test").Page, endereco: string): Promise<number> {
  await isolarIp(page);
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(endereco);
  const inicio = Date.now();
  await page.getByRole("button", { name: "Enviar acesso" }).click();
  await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
  return Date.now() - inicio;
}

test("e-mail não convidado recebe a mesma tela, sem e-mail, sem conta e sem verificação", async ({
  page,
}) => {
  const convidado = emailDeTeste();
  const desconhecido = emailDeTeste("fora");
  await convidarParaTeste(convidado);

  const antesDesconhecido = await linhasDe(desconhecido);
  const antesConvidado = await linhasDe(convidado);
  const emails0 = emailsPara(desconhecido).length;

  await pedir(page, desconhecido);
  const telaDesconhecido = await telaDaEtapa2(page, desconhecido);
  expect(await linhasDe(desconhecido)).toEqual(antesDesconhecido);
  expect(antesDesconhecido).toEqual({ verificacoes: 0, usuarios: 0, convites: 0 });
  await page.waitForTimeout(1000); // o envio, se houvesse, acontece depois da resposta
  expect(emailsPara(desconhecido)).toHaveLength(emails0);

  // Controle positivo: o convidado, pelo mesmo caminho, gera verificação e e-mail.
  await pedir(page, convidado);
  const telaConvidado = await telaDaEtapa2(page, convidado);
  await ultimoEmailPara(convidado);
  expect(emailsPara(convidado).filter((m) => /acesso/i.test(m.assunto))).toHaveLength(1);
  const depoisConvidado = await linhasDe(convidado);
  expect(depoisConvidado.verificacoes).toBeGreaterThan(antesConvidado.verificacoes);
  expect(depoisConvidado.usuarios).toBe(1);

  // A resposta é a mesma, byte a byte, fora o eco do digitado.
  expect(telaDesconhecido).toBe(telaConvidado);
  expect(telaDesconhecido).toContain("Se este e-mail foi convidado, enviamos o acesso.");
});

test("o tempo percebido do pedido é comparável para convidado e não convidado", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "computador",
    "uma medição só: no Chromium, sem concorrência de dois projetos",
  );
  test.setTimeout(240_000);
  const N = 20;
  const convidados = Array.from({ length: N }, () => emailDeTeste());
  await convidarVarios(convidados);
  const desconhecidos = Array.from({ length: N }, () => emailDeTeste("fora"));

  const tempoConvidado: number[] = [];
  const tempoDesconhecido: number[] = [];
  for (let i = 0; i < N; i++) {
    // Intercala para o ruído da máquina cair nos dois lados.
    tempoDesconhecido.push(await pedir(page, desconhecidos[i] as string));
    tempoConvidado.push(await pedir(page, convidados[i] as string));
  }
  const p95 = (valores: number[]) => {
    const ordenado = [...valores].sort((a, b) => a - b);
    return ordenado[Math.min(ordenado.length - 1, Math.ceil(0.95 * ordenado.length) - 1)] as number;
  };
  const resultado = {
    projeto: info.project.name,
    n: N,
    p95_convidado_ms: p95(tempoConvidado),
    p95_nao_convidado_ms: p95(tempoDesconhecido),
    medido_em: new Date().toISOString(),
    nota: "medido no navegador, do toque ao título da etapa 2, contra o servidor de desenvolvimento local",
  };
  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/sp2-tempo-local.json", JSON.stringify(resultado, null, 2));
  expect(Math.abs(resultado.p95_convidado_ms - resultado.p95_nao_convidado_ms)).toBeLessThan(250);
});
