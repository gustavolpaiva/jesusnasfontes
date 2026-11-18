import { expect, test } from "@playwright/test";

test("a página inicial mostra a marca e declara o idioma", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Jesus nas Fontes" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
});

test("a resposta traz os cabeçalhos de segurança", async ({ request }) => {
  const resposta = await request.get("/");
  expect(resposta.status()).toBe(200);
  const csp = resposta.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  expect(resposta.headers()["referrer-policy"]).toBe("no-referrer");
  expect(resposta.headers()["x-content-type-options"]).toBe("nosniff");
});

test("@varredura sem rolagem horizontal na largura do projeto", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const sobra = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(sobra).toBeLessThanOrEqual(0);
});
