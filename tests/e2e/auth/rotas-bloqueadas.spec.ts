import { expect, test } from "@playwright/test";
import { emailsPara, ultimoEmailPara } from "../../support/caixa-de-email";
import { convidarParaTeste, emailDeTeste, isolarIp, pedirAcesso } from "../../support/login-e2e";

// Origem confiável de verdade: sem ela a biblioteca recusaria por conta própria (403) e o teste
// não mediria a nossa lista de permissão.
const ORIGEM = () => new URL(test.info().project.use.baseURL ?? "http://localhost").origin;

const CRUAS = [
  ["POST", "/api/auth/sign-in/magic-link"],
  ["POST", "/api/auth/email-otp/send-verification-otp"],
  ["POST", "/api/auth/sign-in/email-otp"],
  ["POST", "/api/auth/two-factor/verify-totp"],
  ["GET", "/api/auth/magic-link/verify?token=x"],
  ["POST", "/api/auth/sign-in/magic-link/"],
  ["POST", "/api/auth//sign-in/magic-link"],
] as const;

test("as rotas cruas que enviam e-mail respondem 404 e não enviam nada, nem a convidado", async ({
  request,
  page,
}) => {
  const convidado = emailDeTeste();
  const desconhecido = emailDeTeste("fora");
  await convidarParaTeste(convidado);
  const antes = emailsPara(convidado).length + emailsPara(desconhecido).length;

  for (const [metodo, caminho] of CRUAS) {
    for (const email of [convidado, desconhecido]) {
      const resposta =
        metodo === "GET"
          ? await request.get(caminho)
          : await request.post(caminho, {
              data: { email, type: "sign-in", callbackURL: "/" },
              headers: { origin: ORIGEM() },
            });
      expect(resposta.status(), `${metodo} ${caminho}`).toBe(404);
    }
  }
  expect(emailsPara(convidado).length + emailsPara(desconhecido).length).toBe(antes);

  // Controle positivo: o caminho legítimo envia exatamente um e-mail para o convidado.
  await isolarIp(page);
  await pedirAcesso(page, convidado);
  await ultimoEmailPara(convidado);
  expect(emailsPara(convidado).length + emailsPara(desconhecido).length).toBe(antes + 1);
});

test("só get-session e sign-out passam pelo manipulador", async ({ request }) => {
  const sessao = await request.get("/api/auth/get-session");
  expect(sessao.status()).toBe(200);
  expect(await sessao.json()).toBeNull();
  const saida = await request.post("/api/auth/sign-out", {
    data: {},
    headers: { origin: ORIGEM() },
  });
  expect(saida.status()).not.toBe(404);
});

test("sem sessão, as telas de quem entrou levam à entrada", async ({ page }) => {
  await page.goto("/trilhas");
  await expect(page).toHaveURL(/\/entrar\?motivo=sessao/);
  await expect(page.getByText("Sua sessão terminou. Entre de novo.")).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/entrar$/);
});
