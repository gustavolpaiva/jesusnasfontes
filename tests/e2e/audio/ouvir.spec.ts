import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  estadoDaFala,
  falharFala,
  instalarFalaFalsa,
  terminarFala,
  VOZ_EN,
  VOZ_PT_BR,
  VOZ_PT_PT,
} from "../../support/fala-falsa";
import { convidarParaTeste, emailDeTeste, entrarPorLink } from "../../support/login-e2e";

// Ouvir (AUD-01 a AUD-04, tela 8): o botão com a voz do aparelho no Estudo e no texto bíblico. O
// navegador dos testes não tem voz: tudo roda contra um `speechSynthesis` FALSO (tests/support/
// fala-falsa.ts). A voz real de aparelho (Safari, Chrome) não é exercida aqui. Roda com o conteúdo
// mínimo e com o `content/` real: o Estudo "batismo-e-tentacao" existe nos dois, com Mt 3:13 a 4:11.
const ESTUDO = "/estudos/batismo-e-tentacao";
const MSG_SEM_VOZ =
  "Seu aparelho não tem voz em português. Instale uma nas configurações de voz do aparelho para ouvir.";
const MSG_PORTUGAL =
  "Seu aparelho só tem voz em português de Portugal. A leitura funciona, mas o sotaque pode soar diferente.";
const MSG_SEM_API = "Este navegador não lê textos em voz alta. Tente outro navegador.";

async function entrar(page: Page): Promise<void> {
  const email = emailDeTeste("ouvir");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
}

const controle = (page: Page, id: "estudo" | "texto") => page.locator(`[data-ouvir="${id}"]`);
const principal = (c: Locator) => c.locator("button").first();

// O clique antes da hidratação não faz nada: espera o React ligar o botão.
async function esperarHidratado(botao: Locator): Promise<void> {
  await botao.waitFor();
  await botao.evaluate(
    (el) =>
      new Promise<void>((pronto) => {
        const ligado = () => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
        const olhar = () => (ligado() ? pronto() : setTimeout(olhar, 25));
        olhar();
      }),
  );
}

async function abrir(page: Page, config: Parameters<typeof instalarFalaFalsa>[1]): Promise<void> {
  await instalarFalaFalsa(page, config);
  await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(principal(controle(page, "estudo")));
}

const caixa = async (b: Locator) => {
  const c = await b.boundingBox();
  if (!c) throw new Error("botão sem caixa");
  return c;
};

test("nada toca nem é enfileirado antes do toque; Ouvir enfileira as falas do Estudo, sem rótulo de interface", async ({
  page,
}) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const estudo = controle(page, "estudo");
  await expect(principal(estudo)).toHaveAccessibleName("Ouvir o Estudo");
  await expect(principal(estudo)).toHaveText("Ouvir");
  // A página já carregou e as vozes já foram procuradas: nada foi enfileirado.
  await page.waitForTimeout(500);
  expect((await estadoDaFala(page)).enfileiradas).toEqual([]);

  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  await expect(estudo.getByText("Lendo o Estudo")).toBeVisible();
  const fala = await estadoDaFala(page);
  expect(fala.enfileiradas.length).toBeGreaterThan(3);
  expect(fala.enfileiradas[0]).toBe("Batismo e tentação.");
  expect(fala.enfileiradas).toContain("O que acontece.");
  expect(fala.enfileiradas.some((t) => t.startsWith("Leitura bíblica: Mateus, capítulo 3,"))).toBe(
    true,
  );
  expect(fala.linguaUsada).toBe("pt-BR");
  expect(fala.vozUsada).toBe(VOZ_PT_BR.name);
  for (const t of fala.enfileiradas) {
    expect(t.length).toBeLessThanOrEqual(200);
    for (const rotulo of [
      "Fonte em preparação",
      "Ouvir",
      "Pausar",
      "Sessão",
      "Minha anotação",
      "{#",
    ]) {
      expect(t, rotulo).not.toContain(rotulo);
    }
  }
});

test("Pausar, Continuar e Parar mudam os botões sem mover 'Ouvir'/'Pausar'; Parar fica à direita", async ({
  page,
}) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const estudo = controle(page, "estudo");
  const botao = principal(estudo);
  const ocioso = await caixa(botao);

  await botao.click();
  await expect(botao).toHaveText("Pausar");
  const lendo = await caixa(botao);
  const parar = estudo.getByRole("button", { name: "Parar" });
  await expect(parar).toBeVisible();
  const paraCaixa = await caixa(parar);
  expect(paraCaixa.x).toBeGreaterThanOrEqual(lendo.x + lendo.width);
  expect(lendo).toEqual(ocioso);

  // Avança um trecho, pausa e continua: recomeça do trecho em que estava.
  await terminarFala(page);
  const antes = (await estadoDaFala(page)).falados.slice(-1)[0];
  await botao.click();
  await expect(botao).toHaveText("Continuar");
  await expect(estudo.getByText("Pausado")).toBeVisible();
  expect(await caixa(botao)).toEqual(ocioso);
  expect((await estadoDaFala(page)).falando).toBeNull();
  await botao.click();
  await expect(botao).toHaveText("Pausar");
  const depois = await estadoDaFala(page);
  expect(depois.falados.slice(-1)[0]).toBe(antes);
  expect(await caixa(botao)).toEqual(ocioso);

  // Parar: volta ao botão "Ouvir", no mesmo lugar, com o foco nele, e cancela a fala.
  await parar.click();
  await expect(botao).toHaveText("Ouvir");
  await expect(botao).toBeFocused();
  await expect(parar).toHaveCount(0);
  expect(await caixa(botao)).toEqual(ocioso);
  expect((await estadoDaFala(page)).falando).toBeNull();
});

test("o fim da leitura volta ao botão Ouvir", async ({ page }) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const estudo = controle(page, "estudo");
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  const total = (await estadoDaFala(page)).enfileiradas.length;
  for (let i = 0; i < total; i++) await terminarFala(page);
  await expect(principal(estudo)).toHaveText("Ouvir");
  await expect(estudo.getByRole("button", { name: "Parar" })).toHaveCount(0);
});

test("o texto bíblico: 'Ouvir o texto' lê a Passagem sem número de versículo, e iniciar um interrompe o outro", async ({
  page,
}) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const estudo = controle(page, "estudo");
  const texto = controle(page, "texto");
  await expect(principal(texto)).toHaveText("Ouvir o texto");
  await expect(principal(texto)).toHaveAccessibleName("Ouvir o texto bíblico");

  await principal(texto).click();
  await expect(principal(texto)).toHaveText("Pausar");
  await expect(texto.getByText("Lendo o texto bíblico")).toBeVisible();
  await expect(principal(estudo)).toHaveText("Ouvir");
  const lido = await estadoDaFala(page);
  expect(lido.enfileiradas[0]).toMatch(
    /^Mateus, capítulo 3, versículo 13 a capítulo 4, versículo 11\.$/,
  );
  const corrido = lido.enfileiradas.slice(1).join(" ");
  expect(corrido.length).toBeGreaterThan(200);
  // Nenhum trecho abre com número de versículo, nem leva « » ou marca de nota.
  for (const t of lido.enfileiradas) {
    expect(t).not.toMatch(/^\d/);
    expect(t).not.toMatch(/[«»†‡§]/);
  }

  // Iniciar o do Estudo cancela o do texto.
  const cancelamentos = lido.cancelamentos;
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  await expect(principal(texto)).toHaveText("Ouvir o texto");
  await expect(texto.getByRole("button", { name: "Parar" })).toHaveCount(0);
  const depois = await estadoDaFala(page);
  expect(depois.cancelamentos).toBeGreaterThan(cancelamentos);
  expect(depois.falando).toBe("Batismo e tentação.");

  // E o contrário.
  await principal(texto).click();
  await expect(principal(estudo)).toHaveText("Ouvir");
  await expect(principal(texto)).toHaveText("Pausar");
});

test("sair da página cancela a fala", async ({ page }) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  await principal(controle(page, "estudo")).click();
  await expect(principal(controle(page, "estudo"))).toHaveText("Pausar");
  const antes = await estadoDaFala(page);
  expect(antes.falando).not.toBeNull();
  // Navegação do aplicativo (sem recarregar a página): o leitor vive na página que saiu.
  await page.getByRole("link", { name: "Créditos" }).first().click();
  await expect(page).toHaveURL(/\/creditos/);
  const depois = await estadoDaFala(page);
  expect(depois.cancelamentos).toBeGreaterThan(antes.cancelamentos);
  expect(depois.falando).toBeNull();
});

test("sem voz em português: a mensagem aparece sem tocar em nada; o botão é aria-disabled, focável, e não fala", async ({
  page,
}) => {
  await abrir(page, { vozes: [VOZ_EN] });
  const estudo = controle(page, "estudo");
  const texto = controle(page, "texto");
  // Durante a espera pelas vozes (até 2 s), o estado "procurando".
  await expect(estudo.getByText("Procurando voz em português…")).toBeVisible();
  for (const c of [estudo, texto]) {
    await expect(c.getByText(MSG_SEM_VOZ)).toBeVisible({ timeout: 6000 });
    const botao = principal(c);
    await expect(botao).toHaveAttribute("aria-disabled", "true");
    const idDaMensagem = await botao.getAttribute("aria-describedby");
    expect(idDaMensagem).toBeTruthy();
    await expect(page.locator(`[id="${idDaMensagem}"]`)).toHaveText(MSG_SEM_VOZ);
    await botao.focus();
    await expect(botao).toBeFocused();
    // A mensagem é texto na página, nunca dica flutuante.
    await expect(botao).not.toHaveAttribute("title", /./);
  }
  await principal(estudo).click({ force: true });
  await page.keyboard.press("Enter");
  expect((await estadoDaFala(page)).enfileiradas).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("sem nenhuma voz e sem evento: depois de 2 s a mensagem de sem voz aparece", async ({
  page,
}) => {
  await abrir(page, { vozes: [] });
  await expect(controle(page, "estudo").getByText(MSG_SEM_VOZ)).toBeVisible({ timeout: 6000 });
  await expect(principal(controle(page, "estudo"))).toHaveAttribute("aria-disabled", "true");
});

test("as vozes chegam depois (voiceschanged): procurando, e então o botão funciona", async ({
  page,
}) => {
  await abrir(page, { vozes: [VOZ_PT_BR], chegamEmMs: 900 });
  const estudo = controle(page, "estudo");
  await expect(estudo.getByText("Procurando voz em português…")).toBeVisible();
  await expect(estudo.getByText("Procurando voz em português…")).toHaveCount(0, { timeout: 4000 });
  await expect(principal(estudo)).not.toHaveAttribute("aria-disabled", "true");
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
});

test("só português de Portugal: funciona e a meta traz o aviso do sotaque", async ({ page }) => {
  await abrir(page, { vozes: [VOZ_PT_PT] });
  const estudo = controle(page, "estudo");
  await expect(estudo.getByText(MSG_PORTUGAL)).toBeVisible();
  await expect(principal(estudo)).not.toHaveAttribute("aria-disabled", "true");
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  expect((await estadoDaFala(page)).linguaUsada).toBe("pt-PT");
  await expect(estudo.getByText(MSG_PORTUGAL)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("navegador sem leitura em voz: a mensagem do navegador, botão aria-disabled e focável", async ({
  page,
}) => {
  await abrir(page, { vozes: null });
  for (const id of ["estudo", "texto"] as const) {
    const c = controle(page, id);
    await expect(c.getByText(MSG_SEM_API)).toBeVisible();
    await expect(principal(c)).toHaveAttribute("aria-disabled", "true");
    await principal(c).focus();
    await expect(principal(c)).toBeFocused();
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("falha durante a leitura: aviso de status e recomeçar pelo Ouvir", async ({ page }) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const estudo = controle(page, "estudo");
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  await falharFala(page);
  const aviso = estudo.getByRole("status").filter({
    hasText: /Atenção\.\s*A leitura em voz parou\. Toque em Ouvir para recomeçar\./,
  });
  await expect(aviso).toBeVisible();
  await expect(principal(estudo)).toHaveText("Ouvir");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const antes = (await estadoDaFala(page)).falados.length;
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  await expect(aviso).toHaveCount(0);
  expect((await estadoDaFala(page)).falados.length).toBeGreaterThan(antes);
});

test("axe sem violações no Estudo ocioso, lendo e pausado", async ({ page }) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const estudo = controle(page, "estudo");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Continuar");
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test("@varredura os estados cabem na largura (sem rolagem horizontal) e os botões têm 44 px", async ({
  page,
}) => {
  await abrir(page, { vozes: [VOZ_PT_BR] });
  const semRolagem = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
  const estudo = controle(page, "estudo");
  expect(await semRolagem()).toBe(true);
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Pausar");
  for (const b of await estudo.locator("button").all()) {
    expect((await caixa(b)).height).toBeGreaterThanOrEqual(44);
  }
  expect(await semRolagem()).toBe(true);
  await principal(estudo).click();
  await expect(principal(estudo)).toHaveText("Continuar");
  expect(await semRolagem()).toBe(true);
  await principal(controle(page, "texto")).click();
  await expect(principal(controle(page, "texto"))).toHaveText("Pausar");
  expect(await semRolagem()).toBe(true);
});
