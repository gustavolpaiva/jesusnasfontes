import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
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

// Isolamento entre duas contas pela conexão agrupada da Vercel (plano 01-19, Tarefa 1): os dois
// canários escrevem Anotações ao mesmo tempo no mesmo Estudo, e cada um só vê a sua, no Estudo e no
// Caderno. Mesmas variáveis de ambiente e mesmo desligamento de `uat.spec.ts`.

test.describe.configure({ mode: "serial" });

// Uma execução nova por suíte (instância de uso único).
let execucao: ExecucaoCanario;

const ESTUDO = "nicodemos-nascer-de-novo";
const CAPTURAS = "test-results/preview-uat";

test.beforeAll(async () => {
  mkdirSync(CAPTURAS, { recursive: true });
  execucao = novaExecucao();
  await execucao.preparar(PAPEIS);
});

test.afterAll(async () => {
  await execucao?.finalizar();
});

const campo = (page: Page) => page.getByRole("textbox", { name: "Minha anotação" });

test("duas contas escrevendo ao mesmo tempo no mesmo Estudo só veem a própria Anotação", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const a = await abrirSessao(execucao, browser, "estudante", baseURL as string);
  const b = await abrirSessao(execucao, browser, "admin", baseURL as string);
  try {
    const pa = await a.contexto.newPage();
    const pb = await b.contexto.newPage();
    const marcadorA = `MARCADOR-A-${execucao.marca}`;
    const marcadorB = `MARCADOR-B-${execucao.marca}`;

    await test.step("prepara as duas contas (aviso e, no Admin, segundo fator)", async () => {
      await pa.goto("/trilhas");
      await aceitarAviso(pa);
      await expect(pa.getByRole("heading", { level: 1, name: "Trilhas" })).toBeVisible({
        timeout: 30_000,
      });
      await prepararAdmin(pb);
    });

    await test.step("as duas escrevem ao mesmo tempo no mesmo Estudo", async () => {
      await Promise.all([
        escreverAnotacao(pa, ESTUDO, `${marcadorA} da conta A`),
        escreverAnotacao(pb, ESTUDO, `${marcadorB} da conta B`),
      ]);
    });

    await test.step("no Estudo, depois de recarregar, cada uma vê só a sua", async () => {
      for (const [pagina, meu, outro] of [
        [pa, marcadorA, marcadorB],
        [pb, marcadorB, marcadorA],
      ] as const) {
        await pagina.goto(`/estudos/${ESTUDO}`);
        await esperarHidratado(campo(pagina));
        await expect(campo(pagina)).toHaveValue(new RegExp(meu));
        expect(await pagina.content()).not.toContain(outro);
      }
    });

    await test.step("no Caderno, cada uma vê uma entrada e a busca pelo marcador da outra não acha nada", async () => {
      for (const [pagina, meu, outro] of [
        [pa, marcadorA, marcadorB],
        [pb, marcadorB, marcadorA],
      ] as const) {
        await pagina.goto("/caderno");
        await expect(pagina.getByRole("heading", { level: 1, name: "Caderno" })).toBeVisible();
        const entradas = pagina.locator('[data-slot="entrada-caderno"]');
        await expect(entradas).toHaveCount(1);
        await expect(entradas.first()).toContainText(meu);
        expect(await pagina.content()).not.toContain(outro);
        const buscar = pagina.getByRole("button", { name: "Buscar", exact: true });
        await esperarHidratado(buscar);
        await pagina.getByRole("searchbox", { name: "Buscar nas Anotações" }).fill(outro);
        await buscar.click();
        await expect(entradas).toHaveCount(0, { timeout: 20_000 });
      }
    });
  } finally {
    await a.encerrar();
    await b.encerrar();
  }
});
