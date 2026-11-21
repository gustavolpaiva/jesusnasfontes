import { describe, expect, it } from "vitest";
import { mensagemDaFalha, SEM_CONEXAO } from "@/app/(admin)/admin/convites/mensagens";

// Revisão da fase (plano 01-20): um 503 com o navegador "online" escapava do tratador assíncrono e a tela não
// dizia nada. Sinal de navegação do Next (redirecionamento, não encontrado) continua passando adiante.

describe("mensagemDaFalha", () => {
  it("sem conexão: mensagem de conexão", () => {
    expect(mensagemDaFalha(new Error("x"), false)).toBe(SEM_CONEXAO);
  });

  it("com conexão e falha de transporte (503): mensagem recuperável, nunca nulo", () => {
    const m = mensagemDaFalha(
      new Error("An unexpected response was received from the server."),
      true,
    );
    expect(m).not.toBeNull();
    expect(m?.tipo).toBe("erro");
    expect(m?.texto).toBe("Não conseguimos concluir agora. Tente de novo.");
  });

  it("erro comum com digest (em produção o React põe digest em qualquer erro) é falha, não sinal de navegação", () => {
    const comum = Object.assign(new Error("falha do banco"), { digest: "123456789" });
    expect(mensagemDaFalha(comum, true)?.tipo).toBe("erro");
  });

  it("sinal de navegação do Next (redirecionamento, não encontrado) passa adiante: devolve nulo", () => {
    for (const digest of ["NEXT_NOT_FOUND", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      expect(mensagemDaFalha(Object.assign(new Error("x"), { digest }), true), digest).toBeNull();
    }
  });

  it("(sinal de redirecionamento) passa adiante: devolve nulo", () => {
    const sinal = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/entrar;307;",
    });
    expect(mensagemDaFalha(sinal, true)).toBeNull();
  });
});
