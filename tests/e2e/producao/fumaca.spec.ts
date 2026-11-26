import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

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
