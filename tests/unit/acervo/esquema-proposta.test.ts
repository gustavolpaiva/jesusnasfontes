import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  ErroContrato,
  interpretarPropostasYaml,
  normalizarEspaco,
  type PropostaYaml,
} from "@/modules/acervo/schemas";

// Contrato da proposta de Grau e de Citação (plano 02-20, D-04): a FORMA. A conferência de máquina contra o mundo
// (Fonte, ficha, Bíblia) é do validador e tem o teste dela.

const JUSTIFICATIVA =
  "Proposta de teste: a posição que a Fonte relata sobre quanto o fato é aceito.";

const base = (extra: Record<string, unknown> = {}) => ({
  afirmacao: "pc91-a1",
  texto: "Frase sintética de teste.",
  grau_proposto: "consenso",
  justificativa: JUSTIFICATIVA,
  citacoes: [{ alvo: "passagem", referencia: "Lc 2:7" }],
  ...extra,
});

const ler = (...entradas: Record<string, unknown>[]) =>
  interpretarPropostasYaml(stringify(entradas), "t.yaml");
const mensagens = (...entradas: Record<string, unknown>[]) =>
  ler(...entradas).erros.map((e) => e.mensagem);

describe("contrato da proposta: o que aceita", () => {
  it("aceita as três formas de Citação e a forma sem_citacao com motivo", () => {
    const r = ler(
      base({
        citacoes: [
          {
            alvo: "paragrafo",
            fonte: "josefo-antiguidades",
            ref: "18.63",
            trecho: "a wise man, if it be lawful",
          },
          { alvo: "ficha", ficha: "obra-de-teste", item: "argumento-1", pagina: 10 },
          {
            alvo: "ficha",
            ficha: "obra-de-teste",
            item: "trecho-2",
            pagina: "xi-xii",
            trecho: "curto",
          },
          { alvo: "passagem", referencia: "Lc 2:7" },
        ],
      }),
      base({
        afirmacao: "pc91-a2",
        citacoes: undefined,
        sem_citacao: true,
        motivo: "Nenhuma Fonte publicada trata disto.",
      }),
    );
    expect(r.erros).toEqual([]);
    expect(r.propostas).toHaveLength(2);
    const [a] = r.propostas as [PropostaYaml];
    // Página escrita sem aspas no YAML chega como número e vira texto.
    expect(a.citacoes[1]).toMatchObject({ alvo: "ficha", pagina: "10" });
    expect(r.propostas[1]?.citacoes).toEqual([]);
  });

  it("a raiz tem de ser uma lista (arquivo inteiro fora do contrato)", () => {
    expect(() => interpretarPropostasYaml("afirmacao: pc91-a1\n", "t.yaml")).toThrow(ErroContrato);
    expect(() => interpretarPropostasYaml("", "t.yaml")).toThrow(ErroContrato);
    expect(() => interpretarPropostasYaml("a: [", "t.yaml")).toThrow(/ilegível/);
  });
});

describe("contrato da proposta: o que recusa (uma regra por caso)", () => {
  it("Grau fora da lista", () => {
    const m = mensagens(base({ grau_proposto: "certo" }));
    expect(m).toHaveLength(1);
    expect(m[0]).toMatch(/grau_proposto/);
  });

  it("justificativa curta, longa demais ou que rotula pessoa", () => {
    expect(mensagens(base({ justificativa: "curta demais" }))[0]).toMatch(
      /justificativa.*no mínimo 40/,
    );
    expect(mensagens(base({ justificativa: "x".repeat(901) }))[0]).toMatch(/no máximo 900/);
    for (const rotulo of [
      "os crentes aceitam",
      "um cético diria",
      "Céticos duvidam",
      "ateus negam",
    ]) {
      expect(mensagens(base({ justificativa: `${JUSTIFICATIVA} ${rotulo}` }))[0]).toMatch(
        /rotula pessoa/,
      );
    }
  });

  it("alvo desconhecido, campo desconhecido e id de Afirmação fora do padrão", () => {
    expect(mensagens(base({ citacoes: [{ alvo: "livro", titulo: "x" }] }))).toHaveLength(1);
    expect(
      mensagens(base({ citacoes: [{ alvo: "passagem", referencia: "Lc 2:7", extra: 1 }] }))[0],
    ).toMatch(/campo desconhecido: extra/);
    expect(mensagens(base({ extra: 1 }))[0]).toMatch(/campo desconhecido: extra/);
    expect(mensagens(base({ afirmacao: "xx01-a1" }))[0]).toMatch(/id de Afirmação inválido/);
  });

  it("trecho de ficha com mais de 300 caracteres e trecho de parágrafo fora de 12 a 600", () => {
    const ficha = (trecho: string) => ({
      alvo: "ficha",
      ficha: "f",
      item: "trecho-1",
      pagina: "3",
      trecho,
    });
    expect(mensagens(base({ citacoes: [ficha("x".repeat(300))] }))).toEqual([]);
    expect(mensagens(base({ citacoes: [ficha("x".repeat(301))] }))[0]).toMatch(/no máximo 300/);
    const par = (trecho: string) => ({ alvo: "paragrafo", fonte: "f", ref: "1.1", trecho });
    expect(mensagens(base({ citacoes: [par("x".repeat(600))] }))).toEqual([]);
    expect(mensagens(base({ citacoes: [par("x".repeat(601))] }))[0]).toMatch(/no máximo 600/);
    expect(mensagens(base({ citacoes: [par("curto")] }))[0]).toMatch(/no mínimo 12/);
  });

  it("item de ficha fora do padrão e página inválida", () => {
    expect(
      mensagens(base({ citacoes: [{ alvo: "ficha", ficha: "f", item: "a3", pagina: "3" }] }))[0],
    ).toMatch(/item inválido/);
    expect(
      mensagens(
        base({ citacoes: [{ alvo: "ficha", ficha: "f", item: "tese-1", pagina: "3" }] }),
      )[0],
    ).toMatch(/item inválido/);
    expect(
      mensagens(
        base({ citacoes: [{ alvo: "ficha", ficha: "f", item: "trecho-1", pagina: "p. 3" }] }),
      )[0],
    ).toMatch(/página inválida/);
  });

  it("sem Citação e sem sem_citacao; sem_citacao sem motivo; sem_citacao com Citação; motivo sem sem_citacao", () => {
    expect(mensagens(base({ citacoes: [] }))[0]).toMatch(/ao menos uma Citação/);
    expect(mensagens(base({ citacoes: [], sem_citacao: true }))[0]).toMatch(/exige o motivo/);
    expect(mensagens(base({ sem_citacao: true, motivo: "Nenhuma Fonte trata disto." }))[0]).toMatch(
      /não pode haver Citação/,
    );
    expect(mensagens(base({ motivo: "Nenhuma Fonte trata disto." }))[0]).toMatch(
      /só vale com sem_citacao/,
    );
    expect(
      mensagens(base({ citacoes: [], sem_citacao: false, motivo: "Nenhuma Fonte trata." }))[0],
    ).toBeDefined();
  });

  it("a entrada ruim não derruba as boas, e o erro traz o id e a posição, nunca o texto proposto", () => {
    const r = ler(
      base({ afirmacao: "pc91-a1" }),
      base({
        afirmacao: "pc91-a2",
        grau_proposto: "certo",
        justificativa: "SEGREDO-DA-JUSTIFICATIVA",
      }),
      base({ afirmacao: "pc91-a3" }),
    );
    expect(r.propostas.map((p) => p.afirmacao)).toEqual(["pc91-a1", "pc91-a3"]);
    expect(r.erros).toHaveLength(1);
    expect(r.erros[0]).toMatchObject({ indice: 2, afirmacao: "pc91-a2" });
    expect(JSON.stringify(r.erros)).not.toContain("SEGREDO-DA-JUSTIFICATIVA");
  });
});

describe("normalizarEspaco", () => {
  it("junta quebras de linha e espaços repetidos em um espaço só", () => {
    expect(normalizarEspaco("  a\n  b\t\tc  ")).toBe("a b c");
  });
});
