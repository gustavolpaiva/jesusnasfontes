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

  it("sinal de navegação do Next (tem digest) passa adiante: devolve nulo", () => {
    const sinal = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/entrar;307;",
    });
    expect(mensagemDaFalha(sinal, true)).toBeNull();
  });
});
