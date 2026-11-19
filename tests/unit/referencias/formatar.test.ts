import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ErroReferencia,
  formatarReferencia,
  parsearReferencia,
  referenciaParaFala,
} from "../../../src/modules/referencias";

type Entrada = { texto: string; semLivro?: boolean };
const artifact = JSON.parse(
  readFileSync(new URL("../../fixtures/referencias-artifact.json", import.meta.url), "utf8"),
) as Entrada[];

describe("formatarReferencia (por extenso)", () => {
  it("Mt 3:13 a 4:11 vira Mateus 3:13 a 4:11", () => {
    expect(formatarReferencia("Mt 3:13 a 4:11")).toBe("Mateus 3:13 a 4:11");
  });

  it("lista com mais de um livro", () => {
    expect(formatarReferencia("Jo 13:1-17, 13:34-35 e Lc 22:14-20")).toBe(
      "João 13:1-17, 13:34-35 e Lucas 22:14-20",
    );
  });

  it("capítulo inteiro, livro com número e versículo solto", () => {
    expect(formatarReferencia("Mt 1 e Lc 3")).toBe("Mateus 1 e Lucas 3");
    expect(formatarReferencia("1Co 15:1-11")).toBe("1 Coríntios 15:1-11");
    expect(formatarReferencia("Jo 3:16, 18")).toBe("João 3:16 e 3:18");
    expect(formatarReferencia("Jó 1:1")).toBe("Jó 1:1");
  });

  it("recusa o que o interpretador recusa", () => {
    expect(() => formatarReferencia("Mt 29:1")).toThrow(ErroReferencia);
  });
});

describe("referenciaParaFala", () => {
  it("intervalo no mesmo capítulo", () => {
    expect(referenciaParaFala("Mt 3:13-17")).toBe("Mateus, capítulo 3, versículos 13 a 17");
  });

  it("um versículo, capítulo inteiro e intervalo entre capítulos", () => {
    expect(referenciaParaFala("Jo 3:16")).toBe("João, capítulo 3, versículo 16");
    expect(referenciaParaFala("João 18")).toBe("João, capítulo 18");
    expect(referenciaParaFala("Mt 3:13 a 4:11")).toBe(
      "Mateus, capítulo 3, versículo 13 a capítulo 4, versículo 11",
    );
  });

  it("vários itens ficam separados por ponto", () => {
    expect(referenciaParaFala("Mc 2:1-12 e Mt 9:1-8")).toBe(
      "Marcos, capítulo 2, versículos 1 a 12. Mateus, capítulo 9, versículos 1 a 8",
    );
  });
});

describe("as duas formas saem do mesmo interpretador", () => {
  const comLivro = artifact.filter((a) => !a.semLivro);
  it.each(comLivro.map((a) => [a.texto]))(
    "%s: a forma por extenso interpreta para os mesmos intervalos",
    (texto) => {
      const t = texto as string;
      expect(parsearReferencia(formatarReferencia(t))).toEqual(parsearReferencia(t));
      expect(referenciaParaFala(t).length).toBeGreaterThan(0);
    },
  );
});
