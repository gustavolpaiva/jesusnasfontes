import { describe, expect, it } from "vitest";
import { lerEmail, normalizarEmail } from "@/modules/identidade/normalizar-email";

describe("normalizarEmail", () => {
  it("tira espaços das pontas e baixa as maiúsculas", () => {
    expect(normalizarEmail("  Pessoa@Convite.EXAMPLE \n")).toBe("pessoa@convite.example");
  });

  it("aplica NFKC: forma de largura total vira a forma comum", () => {
    // "ｐｅｓｓｏａ@convite.example" com letras de largura total
    expect(normalizarEmail("ｐｅｓｓｏａ@convite.example")).toBe("pessoa@convite.example");
  });

  it("é idempotente", () => {
    const uma = normalizarEmail(" A@B.Example ");
    expect(normalizarEmail(uma)).toBe(uma);
  });
});

describe("lerEmail", () => {
  it("aceita um endereço comum e devolve a forma normalizada (controle positivo)", () => {
    expect(lerEmail(" Pessoa@Convite.Example ")).toBe("pessoa@convite.example");
  });

  it("recusa o que não é endereço", () => {
    for (const ruim of ["", "   ", "sem-arroba", "a@", "@b.example", "a b@c.example", 5, null]) {
      expect(lerEmail(ruim)).toBeNull();
    }
  });

  it("recusa endereço acima de 254 caracteres", () => {
    expect(lerEmail(`${"a".repeat(250)}@b.example`)).toBeNull();
  });
});
