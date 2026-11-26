import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "yaml";

// Fumaça contra a PRODUÇÃO, sem login e sem banco: nada aqui lê ou grava o banco de produção daqui.
//
//   PRODUCAO_URL=https://jesusnasfontes.com.br pnpm exec playwright test tests/e2e/producao
//
// O único pedido de acesso usa um endereço sob example.test, que nunca tem convite: a resposta é a etapa
// neutra e nenhum e-mail sai (o envio só existe para quem tem convite).

const endereco = () => `fumaca-${randomBytes(5).toString("hex")}@fumaca.example.test`;

test("o ambiente da produção é producao", async ({ request }) => {
  const r = await request.get("/api/ambiente");
  expect(r.status()).toBe(200);
  expect(await r.text()).toBe('{"ambiente":"producao"}');
});

test("/entrar responde 200 com CSP, HSTS e Referrer-Policy", async ({ page }) => {
  const r = await page.goto("/entrar");
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const h = r?.headers() ?? {};
  expect(h["content-security-policy"] ?? "").toContain("frame-ancestors 'none'");
  expect(h["strict-transport-security"] ?? "").toContain("max-age=");
  expect(h["referrer-policy"]).toBe("same-origin");
});

test("endereço não convidado recebe a etapa neutra", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(endereco());
  await page.getByRole("button", { name: "Enviar acesso" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Verifique seu e-mail" })).toBeVisible();
  await expect(page.getByText("Se este e-mail foi convidado, enviamos o acesso.")).toBeVisible();
});

for (const rota of ["/api/auth/sign-in/magic-link", "/api/auth/email-otp/send-verification-otp"]) {
  test(`a rota crua ${rota} responde 404`, async ({ request, baseURL }) => {
    const r = await request.post(rota, {
      data: { email: endereco() },
      headers: { origin: baseURL ?? "" },
    });
    expect(r.status()).toBe(404);
  });
}

test("/creditos abre sem sessão", async ({ page }) => {
  const r = await page.goto("/creditos");
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/creditos");
});

test("/trilhas sem sessão leva a /entrar", async ({ page }) => {
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/entrar(\?|$)/);
});

// ───────────────────────── Fase 2 (Acervo), sem login e sem banco ─────────────────────────

for (const rota of ["/acervo", "/acervo/busca", "/acervo/carta-de-neutralidade"]) {
  test(`${rota} sem sessão leva a /entrar`, async ({ page }) => {
    await page.goto(rota);
    await expect(page).toHaveURL(/\/entrar(\?|$)/);
  });
}

// As entradas dos créditos do Acervo vêm do registro de origens e dos YAMLs das Fontes publicadas (os mesmos arquivos de que o
// build de produção carrega o banco): a produção tem de mostrar uma entrada de cada família, com o nome do registro.
type Origem = { nome: string; arquivos: { slug: string }[] };
const origens = parse(readFileSync("data/acervo-origens.yaml", "utf8")) as Record<string, Origem>;
type FonteYaml = { slug: string; publicada: boolean; tipo_texto: string };
const publicadas = new Set(
  readdirSync(join("content", "acervo", "fontes"))
    .filter((nome) => nome.endsWith(".yaml"))
    .map(
      (nome) => parse(readFileSync(join("content", "acervo", "fontes", nome), "utf8")) as FonteYaml,
    )
    .filter((f) => f.publicada && f.tipo_texto === "integral")
    .map((f) => f.slug),
);

test("/creditos mostra Textos do Acervo e uma entrada de cada família (Perseus, CCEL, Gutenberg, gospels.net)", async ({
  page,
}) => {
  const r = await page.goto("/creditos");
  expect(r?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 2, name: "Textos do Acervo" })).toBeVisible();
  const titulos = await page.getByRole("heading", { level: 3 }).allInnerTexts();
  for (const familia of ["perseus", "ccel", "gutenberg", "gospels"]) {
    const nomes = Object.entries(origens)
      .filter(
        ([chave, o]) => chave.startsWith(familia) && o.arquivos.some((a) => publicadas.has(a.slug)),
      )
      .map(([, o]) => o.nome);
    expect(
      nomes.length,
      `a família ${familia} tem origem com derivado no registro`,
    ).toBeGreaterThan(0);
    expect(
      titulos.some((t) => nomes.includes(t)),
      `uma entrada da família ${familia} nos créditos`,
    ).toBe(true);
  }
});

// O painel do Admin não revela que existe: sem sessão a resposta é a de uma rota que nunca existiu (mesmo status e mesma tela).
test("/admin/acervo/fontes e /admin/acervo/fichas sem sessão respondem como qualquer rota inexistente", async ({
  page,
}) => {
  const inexistente = await page.goto(
    `/admin/rota-que-nunca-existiu-${randomBytes(4).toString("hex")}`,
  );
  const statusBase = inexistente?.status();
  const tituloBase = await page.getByRole("heading", { level: 1 }).first().innerText();
  for (const rota of ["/admin/acervo/fontes", "/admin/acervo/fichas"]) {
    const r = await page.goto(rota);
    expect(r?.status(), rota).toBe(statusBase);
    expect(new URL(page.url()).pathname, rota).toBe(rota);
    await expect(page.getByRole("heading", { level: 1 }).first(), rota).toHaveText(tituloBase);
  }
});
