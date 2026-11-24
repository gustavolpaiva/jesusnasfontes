import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { interpretarDerivado, interpretarFichaYaml } from "@/modules/acervo/schemas";
import { lerPastaDePropostas, type PropostaLida } from "../../../scripts/acervo/propostas";
import {
  type ContextoDeValidacao,
  executarValidacao,
  lerOpcoes,
  validarPropostas,
} from "../../../scripts/acervo/validar-propostas";

// O validador de máquina das propostas (plano 02-20). Controle positivo: a fixture sintética aprova inteira. Cada
// regra reprovada tem o seu caso. A saída NUNCA carrega justificativa, trecho ou frase.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo");
const PASTA_PROPOSTAS = path.join(FIXTURES, "rascunhos", "propostas");
const PASTA_FICHAS = path.join(FIXTURES, "rascunhos", "fichas");

const josefo = interpretarDerivado(
  JSON.parse(readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8")),
  "josefo-antiguidades.json",
);
const ficha = interpretarFichaYaml(
  readFileSync(path.join(PASTA_FICHAS, "obra-de-teste.yaml"), "utf8"),
  "obra-de-teste.yaml",
);

const AFIRMACOES = new Map([
  ["pc91-a1", "Frase sintética um, sobre o testemunho de um historiador antigo."],
  ["pc91-a2", "Frase sintética dois, apoiada numa ficha fictícia."],
  ["pc91-a3", "Frase sintética três, apoiada num texto bíblico."],
  ["pc91-a4", "Frase sintética quatro, sem nenhuma Fonte do Acervo."],
]);

const contexto = (extra: Partial<ContextoDeValidacao> = {}): ContextoDeValidacao => ({
  afirmacoes: AFIRMACOES,
  derivado: (slug) => (slug === "josefo-antiguidades" ? josefo : null),
  ficha: (slug) => (slug === "obra-de-teste" ? ficha : null),
  ...extra,
});

const lidas = (): PropostaLida[] => {
  const r = lerPastaDePropostas(PASTA_PROPOSTAS);
  expect(r.erros).toEqual([]);
  return r.propostas;
};

/** Troca uma entrada da fixture por uma variação e devolve as regras reprovadas dela. */
function regrasDe(
  id: string,
  mudar: (p: PropostaLida) => PropostaLida,
  ctx: ContextoDeValidacao = contexto(),
): string[] {
  const propostas = lidas().map((p) => (p.afirmacao === id ? mudar(p) : p));
  const r = validarPropostas(propostas, ctx);
  return r.veredictos.find((v) => v.afirmacao === id)?.regras ?? [];
}

describe("validarPropostas: controle positivo", () => {
  it("a fixture sintética aprova inteira e a contagem sai do validador", () => {
    const r = validarPropostas(lidas(), contexto(), { completo: true });
    expect(r.veredictos.every((v) => v.regras.length === 0)).toBe(true);
    expect(r).toMatchObject({
      entradas: 4,
      aprovadas: 4,
      reprovadas: 0,
      semCitacao: 1,
      pendentes: [],
      ok: true,
      afirmacoesNoConteudo: 4,
    });
    expect(r.citacoes).toEqual({ paragrafo: 1, ficha: 2, passagem: 2 });
    expect(r.porPrefixo).toEqual({ bh: 0, pc: 4 });
  });
});

describe("validarPropostas: uma reprovação por regra", () => {
  it("Afirmação inexistente no conteúdo", () => {
    const r2 = validarPropostas(
      lidas().map((p) => (p.afirmacao === "pc91-a1" ? { ...p, afirmacao: "pc99-a9" } : p)),
      contexto(),
    );
    expect(r2.veredictos.find((v) => v.afirmacao === "pc99-a9")?.regras).toEqual([
      "Afirmação inexistente no conteúdo dos Estudos",
    ]);
    // E a Afirmação que ficou sem entrada aparece como pendente.
    expect(r2.pendentes).toEqual(["pc91-a1"]);
  });

  it("texto da Afirmação que mudou", () => {
    const ctx = contexto({
      afirmacoes: new Map([...AFIRMACOES, ["pc91-a3", "Outra frase, o Estudo mudou."]]),
    });
    expect(regrasDe("pc91-a3", (p) => p, ctx)).toEqual([
      "o texto da Afirmação mudou (ou foi copiado errado)",
    ]);
  });

  it("trecho de parágrafo que NÃO é substring literal do parágrafo", () => {
    const r = regrasDe("pc91-a1", (p) => ({
      ...p,
      citacoes: p.citacoes.map((c) =>
        c.alvo === "paragrafo"
          ? { ...c, trecho: "a wise man, if it be lawful to call him a prophet" }
          : c,
      ),
    }));
    expect(r).toEqual(["trecho não é cópia literal do parágrafo josefo-antiguidades/18.63"]);
  });

  it("o espaço do trecho é normalizado (quebra de linha e recuo não reprovam)", () => {
    const r = regrasDe("pc91-a1", (p) => ({
      ...p,
      citacoes: p.citacoes.map((c) =>
        c.alvo === "paragrafo" ? { ...c, trecho: "a wise man,\n   if it be   lawful" } : c,
      ),
    }));
    expect(r).toEqual([]);
  });

  it("parágrafo que não existe no derivado e Fonte sem derivado", () => {
    const outraRef = regrasDe("pc91-a1", (p) => ({
      ...p,
      citacoes: p.citacoes.map((c) => (c.alvo === "paragrafo" ? { ...c, ref: "18.99" } : c)),
    }));
    expect(outraRef).toEqual(["parágrafo josefo-antiguidades/18.99 inexistente no derivado"]);
    const semDerivado = regrasDe("pc91-a1", (p) => ({
      ...p,
      citacoes: p.citacoes.map((c) =>
        c.alvo === "paragrafo" ? { ...c, fonte: "tacito-anais" } : c,
      ),
    }));
    expect(semDerivado).toEqual(["Fonte tacito-anais sem derivado versionado"]);
  });

  it("referência de Passagem inexistente, ilegível e com mais de um intervalo", () => {
    const com = (referencia: string) =>
      regrasDe("pc91-a3", (p) => ({ ...p, citacoes: [{ alvo: "passagem", referencia }] }));
    expect(com("Lc 2:7-8")).toEqual([]);
    expect(com("Lc 2:999")).toEqual(["referência de Passagem inexistente ou inválida"]);
    expect(com("Lc 99:1")).toEqual(["referência de Passagem inexistente ou inválida"]);
    expect(com("Livro Inventado 1:1")).toEqual(["referência de Passagem inexistente ou inválida"]);
    expect(com("Lc 2:7, 10")).toEqual([
      "a Passagem deve ser um intervalo contínuo só (uma Citação por intervalo)",
    ]);
  });

  it("ficha inexistente, item inexistente, página divergente e trecho que não é do original", () => {
    const ficha2 = (mudanca: Record<string, unknown>) =>
      regrasDe("pc91-a2", (p) => ({
        ...p,
        citacoes: [
          {
            alvo: "ficha",
            ficha: "obra-de-teste",
            item: "argumento-1",
            pagina: "10",
            ...mudanca,
          } as never,
        ],
      }));
    expect(ficha2({})).toEqual([]);
    expect(ficha2({ ficha: "obra-fantasma" })).toEqual(["ficha obra-fantasma inexistente"]);
    expect(ficha2({ item: "argumento-9" })).toEqual([
      "item argumento-9 inexistente na ficha obra-de-teste",
    ]);
    expect(ficha2({ pagina: "11" })).toEqual([
      "página diferente da que a ficha traz para obra-de-teste/argumento-1",
    ]);
    // O argumento não tem trecho original: citar trecho dele reprova.
    expect(ficha2({ trecho: "qualquer coisa" })).toEqual([
      "o item obra-de-teste/argumento-1 não tem trecho original para citar",
    ]);
    expect(
      ficha2({ item: "trecho-1", pagina: "xi-xii", trecho: "invented test sentence" }),
    ).toEqual([]);
    expect(
      ficha2({ item: "trecho-1", pagina: "xi-xii", trecho: "texto inventado depois" }),
    ).toEqual(["trecho não é literal do original do item obra-de-teste/trecho-1"]);
  });

  it("ficha sem pasta de fichas informada", () => {
    const r = regrasDe("pc91-a2", (p) => p, contexto({ ficha: () => "sem-pasta" }));
    expect(r[0]).toMatch(/pasta de fichas não informada/);
  });

  it("Afirmação repetida na lista", () => {
    const propostas = [...lidas(), ...lidas().filter((p) => p.afirmacao === "pc91-a3")];
    const r = validarPropostas(propostas, contexto());
    const repetidas = r.veredictos.filter((v) => v.afirmacao === "pc91-a3");
    expect(repetidas).toHaveLength(2);
    expect(repetidas[0]?.regras).toEqual([]);
    expect(repetidas[1]?.regras).toEqual(["Afirmação repetida na lista de propostas"]);
    expect(r.ok).toBe(false);
  });

  it("Afirmação sem entrada: pendente, e só reprova com --completo", () => {
    const parcial = lidas().filter((p) => p.afirmacao !== "pc91-a4");
    const solta = validarPropostas(parcial, contexto());
    expect(solta.pendentes).toEqual(["pc91-a4"]);
    expect(solta.ok).toBe(true);
    const completa = validarPropostas(parcial, contexto(), { completo: true });
    expect(completa.ok).toBe(false);
    expect(completa.reprovadas).toBe(0);
  });
});

describe("executarValidacao: saída e código de saída", () => {
  const opcoes = (extra: Record<string, unknown> = {}) => ({
    propostas: PASTA_PROPOSTAS,
    fichas: PASTA_FICHAS,
    conteudo: "(não usado)",
    completo: false,
    listar: false,
    ...extra,
  });

  it("aprova a fixture: OK por Afirmação, contagens e saída 0", async () => {
    const saida: string[] = [];
    const codigo = await executarValidacao(opcoes({ completo: true }), {
      contexto: async () => contexto(),
      escrever: (l) => saida.push(l),
    });
    expect(codigo).toBe(0);
    expect(saida.filter((l) => l.startsWith("OK "))).toEqual([
      "OK pc91-a1",
      "OK pc91-a2",
      "OK pc91-a3",
      "OK pc91-a4",
    ]);
    expect(saida).toContain("citacoes: paragrafo=1 ficha=2 passagem=2 sem_citacao=1");
    expect(saida).toContain("por-faixa: bh=0 pc=4");
    expect(saida.some((l) => l.startsWith("entradas=4 aprovadas=4 reprovadas=0 pendentes=0"))).toBe(
      true,
    );
  });

  it("reprova saindo 1, e a saída nunca traz justificativa, trecho, motivo ou frase", async () => {
    const saida: string[] = [];
    const codigo = await executarValidacao(opcoes(), {
      contexto: async () =>
        contexto({
          afirmacoes: new Map([
            ...AFIRMACOES,
            ["pc91-a1", "A frase do Estudo mudou por completo."],
          ]),
          derivado: () => null,
        }),
      escrever: (l) => saida.push(l),
    });
    expect(codigo).toBe(1);
    const tudo = saida.join("\n");
    expect(tudo).toMatch(/REPROVADO pc91-a1: o texto da Afirmação mudou/);
    for (const privado of [
      "MARCADOR-JUSTIFICATIVA-PRIVADA",
      "a wise man",
      "invented test sentence",
      "Nenhuma Fonte publicada do Acervo",
      "Frase sintética",
      "A frase do Estudo mudou",
    ])
      expect(tudo).not.toContain(privado);
  });

  it("--listar-afirmacoes imprime id e frase (conteúdo público dos Estudos) e não lê proposta", async () => {
    const saida: string[] = [];
    const codigo = await executarValidacao(opcoes({ propostas: undefined, listar: true }), {
      contexto: async () => contexto(),
      escrever: (l) => saida.push(l),
    });
    expect(codigo).toBe(0);
    expect(saida[0]).toBe(
      "pc91-a1\tFrase sintética um, sobre o testemunho de um historiador antigo.",
    );
    expect(saida.at(-1)).toBe("afirmacoes=4");
  });

  it("sem pasta de propostas lança; a pasta é opção explícita ou ACERVO_PROPOSTAS_DIR, nunca padrão", async () => {
    await expect(
      executarValidacao(opcoes({ propostas: undefined }), {
        contexto: async () => contexto(),
        escrever: () => {},
      }),
    ).rejects.toThrow(/pasta de propostas é obrigatória/);
    expect(lerOpcoes([], {}).propostas).toBeUndefined();
    expect(lerOpcoes([], { ACERVO_PROPOSTAS_DIR: PASTA_PROPOSTAS }).propostas).toBe(
      PASTA_PROPOSTAS,
    );
    expect(lerOpcoes(["--propostas", PASTA_PROPOSTAS, "--completo"], {})).toMatchObject({
      propostas: PASTA_PROPOSTAS,
      completo: true,
    });
    expect(() => lerOpcoes(["--propostas"], {})).toThrow(/Uso:/);
  });

  it("entrada fora do contrato reprova com o id e sai 1", async () => {
    const saida: string[] = [];
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const pasta = mkdtempSync(path.join(tmpdir(), "jnf-propostas-"));
    try {
      writeFileSync(
        path.join(pasta, "p.yaml"),
        "- afirmacao: pc91-a1\n  texto: x\n  grau_proposto: certo\n  justificativa: SEGREDO-DA-JUSTIFICATIVA\n",
      );
      const codigo = await executarValidacao(opcoes({ propostas: pasta }), {
        contexto: async () => contexto(),
        escrever: (l) => saida.push(l),
      });
      expect(codigo).toBe(1);
      expect(saida.join("\n")).toMatch(/REPROVADO pc91-a1 \(p\.yaml\): grau_proposto/);
      expect(saida.join("\n")).not.toContain("SEGREDO-DA-JUSTIFICATIVA");
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
