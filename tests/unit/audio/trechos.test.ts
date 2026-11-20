import { describe, expect, it } from "vitest";
import { dividirEmTrechos, TAMANHO_MAXIMO_DO_TRECHO } from "@/modules/audio/trechos";

describe("dividirEmTrechos", () => {
  it("uma frase por trecho, na ordem", () => {
    expect(dividirEmTrechos("Primeira frase. Segunda frase? Terceira!")).toEqual([
      "Primeira frase.",
      "Segunda frase?",
      "Terceira!",
    ]);
  });

  it("linha em branco separa parágrafos e nunca vira trecho vazio", () => {
    const trechos = dividirEmTrechos("Um.\n\n\nDois sem ponto\n\n   \nTrês.");
    expect(trechos).toEqual(["Um.", "Dois sem ponto", "Três."]);
  });

  it("nenhum trecho passa de 200 caracteres, mesmo numa frase enorme e sem vírgula", () => {
    const comVirgulas = Array.from({ length: 60 }, (_, i) => `parte número ${i} da frase`).join(
      ", ",
    );
    const semVirgulas = Array.from({ length: 120 }, (_, i) => `palavra${i}`).join(" ");
    for (const texto of [comVirgulas, semVirgulas, `${comVirgulas}. ${semVirgulas}.`]) {
      const trechos = dividirEmTrechos(texto);
      expect(trechos.length).toBeGreaterThan(1);
      for (const t of trechos) expect(t.length).toBeLessThanOrEqual(TAMANHO_MAXIMO_DO_TRECHO);
      // Nada se perde: as mesmas palavras, na mesma ordem.
      expect(trechos.join(" ").replace(/\s+/g, " ")).toBe(texto.replace(/\s+/g, " "));
    }
  });

  it("quebra a frase longa nas vírgulas, não no meio das palavras", () => {
    const frase = `${"a".repeat(120)}, ${"b".repeat(120)}.`;
    expect(dividirEmTrechos(frase)).toEqual([`${"a".repeat(120)},`, `${"b".repeat(120)}.`]);
  });

  it("palavra maior que o limite ainda respeita o limite", () => {
    const trechos = dividirEmTrechos("x".repeat(450));
    expect(trechos.length).toBe(3);
    for (const t of trechos) expect(t.length).toBeLessThanOrEqual(200);
  });

  it("texto vazio não gera trecho", () => {
    expect(dividirEmTrechos("")).toEqual([]);
    expect(dividirEmTrechos("  \n \n")).toEqual([]);
  });
});
