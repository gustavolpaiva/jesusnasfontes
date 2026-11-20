import { expect, type Page, test } from "@playwright/test";
import { esperarHidratado } from "../../support/hidratacao";
import {
  contar,
  convidarParaTeste,
  emailDeTeste,
  entrarPorLink,
  idDoUsuario,
  lerTexto,
} from "../../support/login-e2e";

// Anotação (ANOT-01, ANOT-02): digitar no Estudo, salvar sozinha 1,5 s depois, reencontrar o texto ao reabrir;
// rascunho no aparelho quando a conexão cai; limite; apagar. Roda sobre o conteúdo mínimo de teste
// (E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo).
test.skip(
  !process.env.E2E_CONTEUDO_DIR?.includes("conteudo-minimo"),
  "usa o conteúdo mínimo: rode com E2E_CONTEUDO_DIR=tests/fixtures/conteudo-minimo",
);

const ESTUDO = "/estudos/o-nascimento";

async function entrar(page: Page): Promise<{ email: string; id: string }> {
  const email = emailDeTeste("anot");
  await convidarParaTeste(email);
  await entrarPorLink(page, email);
  return { email, id: await idDoUsuario(email) };
}

const campo = (page: Page) => page.getByRole("textbox", { name: "Minha anotação" });
const estado = (page: Page) => page.locator('[data-slot="save-status"]');
const anotacoesDe = (id: string) =>
  contar("select count(*) as n from privado.anotacao where estudante_id = $1", [id]);
const corpoDe = (id: string) =>
  lerTexto("select corpo as t from privado.anotacao where estudante_id = $1", [id]);
const versaoDe = (id: string) =>
  contar("select versao as n from privado.anotacao where estudante_id = $1", [id]);

// As chaves de rascunho que o aparelho guarda agora.
const chavesDeRascunho = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.localStorage).filter((c) => c.startsWith("jnf:rascunho:")),
  );

// Guarda, desde antes da página montar, cada texto que o estado de salvamento passa a mostrar: provar que
// um estado de 1,5 s apareceu não pode depender de olhar no instante certo.
async function registrarEstados(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __estados: string[] };
    w.__estados = [];
    const ligar = () => {
      const alvo = document.querySelector('[data-slot="save-status"]');
      if (!alvo) {
        requestAnimationFrame(ligar);
        return;
      }
      new MutationObserver(() => {
        const t = (alvo.textContent ?? "").trim();
        if (t && w.__estados[w.__estados.length - 1] !== t) w.__estados.push(t);
      }).observe(alvo, { childList: true, subtree: true, characterData: true });
    };
    ligar();
  });
}
const estadosVistos = (page: Page) =>
  page.evaluate(() => (window as unknown as { __estados: string[] }).__estados);

test("digitar, ver Salvo, recarregar e ver o texto; editar de novo incrementa a versão", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await registrarEstados(page);
  await page.goto(ESTUDO);

  // Estudo sem Anotação: o campo vazio com o rótulo e a ajuda do contrato, sem texto de preenchimento.
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
  await expect(campo(page)).not.toHaveAttribute("placeholder", /.+/);
  await expect(
    page.getByText("Privada: nenhum Estudante nem Admin lê pelo site. Salva sozinha."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Como funciona" })).toHaveAttribute(
    "href",
    "/privacidade",
  );

  await campo(page).fill("Primeira Anotação, escrita com calma.");
  // O primeiro caractere já está no rascunho do aparelho, antes de o servidor receber nada.
  expect(await chavesDeRascunho(page)).toHaveLength(1);
  await expect(estado(page)).toHaveText("Salvo");
  expect(await estadosVistos(page)).toContain("Salvando…");
  // Salvo no servidor, uma linha, versão 1; o rascunho local saiu.
  expect(await anotacoesDe(id)).toBe(1);
  expect(await corpoDe(id)).toBe("Primeira Anotação, escrita com calma.");
  expect(await versaoDe(id)).toBe(1);
  expect(await chavesDeRascunho(page)).toHaveLength(0);

  // Recarregar: o texto volta igual, do servidor.
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("Primeira Anotação, escrita com calma.");

  // Editar de novo incrementa a versão e não cria outra linha.
  await campo(page).fill("Primeira Anotação, escrita com calma. Mais uma frase.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await versaoDe(id)).toBe(2);
  expect(await anotacoesDe(id)).toBe(1);
});

test("apagar todo o texto remove a Anotação do servidor", async ({ page }) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill("Vai ser apagada.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await anotacoesDe(id)).toBe(1);
  await campo(page).fill("");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await anotacoesDe(id)).toBe(0);
  await page.reload();
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
});

test("a Anotação é de cada Estudo: outro Estudo abre vazio e a primeira continua lá", async ({
  page,
}) => {
  const { id } = await entrar(page);
  await page.goto(ESTUDO);
  await esperarHidratado(campo(page));
  await campo(page).fill("Do primeiro Estudo.");
  await expect(estado(page)).toHaveText("Salvo");
  await page.goto("/estudos/batismo-e-tentacao");
  await esperarHidratado(campo(page));
  await expect(campo(page)).toHaveValue("");
  await campo(page).fill("Do segundo Estudo.");
  await expect(estado(page)).toHaveText("Salvo");
  expect(await anotacoesDe(id)).toBe(2);
  await page.goto(ESTUDO);
  await expect(campo(page)).toHaveValue("Do primeiro Estudo.");
});
