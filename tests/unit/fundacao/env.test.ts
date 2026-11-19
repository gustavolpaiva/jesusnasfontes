import { describe, expect, it } from "vitest";
import { urlDoPapel } from "@/db/url";
import { envBanco, envBancoDoPapel, envEmail, envTeste, urlBase } from "@/lib/env";

describe("env", () => {
  it("variável ausente lista o nome e não o valor", () => {
    const segredo = "valor-secreto-que-nao-pode-vazar";
    const chamar = () => envBanco({ NEON_HOST: segredo });
    expect(chamar).toThrow(/JNF_APP_PASSWORD/);
    try {
      chamar();
    } catch (erro) {
      expect(String((erro as Error).message)).not.toContain(segredo);
    }
  });

  it("o papel do aplicativo exige só a senha dele, e a de outro papel só a dele (privilégio mínimo)", () => {
    const soApp = { NEON_HOST: "h.example", NEON_DATABASE: "d", JNF_APP_PASSWORD: "a" };
    // Controle positivo: com só a senha do app, a URL do app sai.
    expect(urlDoPapel("app", { agrupada: false }, soApp)).toContain("jnf_app:a@");
    expect(envBancoDoPapel("app", soApp).senha).toBe("a");
    // Negativo: sem a senha do app falha, e nomeia só a do app (não as de migração, carga e Assistente).
    const semSenha = { NEON_HOST: "h.example", NEON_DATABASE: "d", JNF_MIGRA_PASSWORD: "m" };
    expect(() => envBancoDoPapel("app", semSenha)).toThrow(/JNF_APP_PASSWORD/);
    expect(() => envBancoDoPapel("app", semSenha)).not.toThrow(
      /JNF_MIGRA|JNF_CARGA|JNF_ASSISTENTE/,
    );
    // As quatro juntas continuam exigidas por quem prepara o banco.
    expect(() => envBanco(soApp)).toThrow(/JNF_MIGRA_PASSWORD/);
  });

  it("valor inválido também não é repetido na mensagem", () => {
    const segredo = "transporte-invalido-secreto";
    try {
      envEmail({ MAIL_TRANSPORT: segredo });
      expect.unreachable();
    } catch (erro) {
      const mensagem = String((erro as Error).message);
      expect(mensagem).toContain("MAIL_TRANSPORT");
      expect(mensagem).not.toContain(segredo);
    }
  });

  it("transporte de e-mail: arquivo fora da Vercel, resend nela", () => {
    expect(envEmail({}).MAIL_TRANSPORT).toBe("arquivo");
    expect(() => envEmail({ VERCEL: "1" })).toThrow(/RESEND_API_KEY.*EMAIL_FROM/);
    expect(
      envEmail({ VERCEL: "1", RESEND_API_KEY: "x", EMAIL_FROM: "a@b.example" }).MAIL_TRANSPORT,
    ).toBe("resend");
  });

  it("alvo do banco tem padrão local", () => {
    expect(envTeste({}).ALVO_BANCO).toBe("local");
    expect(envTeste({ PORTA_E2E: "3101" }).PORTA_E2E).toBe(3101);
  });

  it("urlBase segue APP_URL, depois VERCEL_URL, depois a porta local", () => {
    expect(urlBase({ APP_URL: "https://app.example.com/" })).toBe("https://app.example.com");
    expect(urlBase({ VERCEL_URL: "x.vercel.app" })).toBe("https://x.vercel.app");
    expect(urlBase({ PORTA_E2E: "3105" })).toBe("http://localhost:3105");
  });
});
