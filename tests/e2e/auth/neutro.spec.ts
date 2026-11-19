import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emailsPara, ultimoEmailPara } from "../../support/caixa-de-email";
import {
  convidarEmLote,
  convidarParaTeste,
  emailDeTeste,
  isolarIp,
  linhasDe,
} from "../../support/login-e2e";

// Troca o endereço digitado por um marcador: o eco do digitado é a única diferença legítima. Tira
// também os atributos de seleção que a biblioteca do campo de código escreve no DOM quando o foco
// chega (data-input-otp-mss/-mse): são estado de interação, aparecem ou não conforme o instante em
// que o HTML é lido, e não fazem parte do conteúdo da resposta.
async function telaDaEtapa2(page: import("@playwright/test").Page, endereco: string) {
  const html = await page.locator("main").innerHTML();
  return html
    .replace(/ data-input-otp-ms[se]="\d+"/g, "")
    .split(endereco)
    .join("[EMAIL]");
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

// Mediana e intervalo de 95% (bootstrap simples) da mediana das diferenças pareadas.
function mediana(v: number[]): number {
  const o = [...v].sort((x, y) => x - y);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? (o[m] as number) : ((o[m - 1] as number) + (o[m] as number)) / 2;
}

function intervalo(v: number[]): [number, number] {
  const medias = Array.from({ length: 1000 }, () =>
    mediana(
      Array.from({ length: v.length }, () => v[Math.floor(Math.random() * v.length)] as number),
    ),
  ).sort((x, y) => x - y);
  return [medias[25] as number, medias[974] as number];
}

// Limite da diferença pareada mediana: o maior entre 20 ms e 25% da mediana do caminho não
// convidado. Justificativa: em 200 pares por caminho (JNF_PARES=200), duas execuções com a máquina
// quieta deram diferença mediana de 1,6 ms (IC 95% de 1,3 a 2,4 ms e de 1,1 a 2,2 ms) e três
// execuções de 60 pares com 4 processos de carga deram de 1,8 a 2,4 ms; as medianas dos caminhos
// ficam entre 19 e 24 ms. 20 ms é cerca de 8 vezes o maior valor medido e fica no patamar em que
// uma diferença já seria um achado real. A parte relativa existe porque a carga da máquina estica
// as duas durações na mesma proporção, e o gate não pode reprovar por isso. A propriedade
// estrutural (mesmas operações) é provada, sem tempo, em tests/integration/identidade/
// equivalencia.test.ts. A medição de produção, que é a prova do tempo percebido, é o SP-2 do plano
// 01-11.
const LIMITE_MS = 20;
const LIMITE_RELATIVO = 0.25;
const PARES = Number(process.env.JNF_PARES ?? 60);
const DESCARTADOS = 5;

// MEDIÇÃO, não portão: leva de 1 a 1,5 minuto (60 pares). Fica fora do `pnpm verify` e roda sozinha por
// `pnpm medir:tempo` (projeto `medicao-tempo`); o portão guarda a propriedade ESTRUTURAL (mesmas
// operações), em equivalencia.test.ts.
test(
  "tempo percebido: a diferença pareada mediana entre convidado e não convidado é pequena",
  {
    tag: "@medicao-tempo",
  },
  async ({ page }, info) => {
    test.skip(info.project.name !== "medicao-tempo", "só no projeto de medição");
    test.setTimeout(300_000 + PARES * 4_000);
    const total = PARES + DESCARTADOS;
    const convidados = Array.from({ length: total }, () => emailDeTeste());
    const desconhecidos = Array.from({ length: total }, () => emailDeTeste("fora"));
    await convidarEmLote(convidados);

    // Duração da resposta do pedido (a ação do servidor), na mesma página já aquecida.
    const um = async (endereco: string): Promise<number> => {
      await isolarIp(page);
      await page.goto("/entrar");
      await page.getByLabel("E-mail").fill(endereco);
      const [resposta] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/entrar")),
        page.getByRole("button", { name: "Enviar acesso" }).click(),
      ]);
      await page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" }).waitFor();
      const t = resposta.request().timing();
      return t.responseEnd - t.requestStart;
    };

    const convidado: number[] = [];
    const naoConvidado: number[] = [];
    for (let i = 0; i < total; i++) {
      // Intercalado, alternando quem vai primeiro para o efeito de ordem se cancelar.
      const convPrimeiro = i % 2 === 0;
      const primeiro = await um((convPrimeiro ? convidados : desconhecidos)[i] as string);
      const segundo = await um((convPrimeiro ? desconhecidos : convidados)[i] as string);
      if (i < DESCARTADOS) continue;
      convidado.push(convPrimeiro ? primeiro : segundo);
      naoConvidado.push(convPrimeiro ? segundo : primeiro);
    }
    const diferencas = convidado.map((c, i) => c - (naoConvidado[i] as number));
    const resultado = {
      projeto: info.project.name,
      pares: PARES,
      mediana_convidado_ms: mediana(convidado),
      mediana_nao_convidado_ms: mediana(naoConvidado),
      mediana_da_diferenca_pareada_ms: mediana(diferencas),
      intervalo95_da_mediana_ms: intervalo(diferencas),
      limite_ms: Math.max(LIMITE_MS, LIMITE_RELATIVO * mediana(naoConvidado)),
      medido_em: new Date().toISOString(),
      nota: "duração da resposta da ação do servidor, medida no navegador, pares intercalados na mesma página aquecida, contra o servidor de desenvolvimento local",
    };
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/sp2-tempo-local.json", JSON.stringify(resultado, null, 2));
    expect(Math.abs(resultado.mediana_da_diferenca_pareada_ms)).toBeLessThan(resultado.limite_ms);
  },
);
