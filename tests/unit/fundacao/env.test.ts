import { describe, expect, it } from "vitest";
import { envBanco, envEmail, envTeste, urlBase } from "@/lib/env";

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
