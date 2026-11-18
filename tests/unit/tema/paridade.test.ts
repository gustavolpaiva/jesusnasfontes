import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ESCALAS, lerPreferencias } from "@/modules/aparencia/preferencias";

const css = readFileSync("src/app/globals.css", "utf8");

// Devolve o texto entre chaves que começa logo depois do seletor, contando chaves aninhadas.
function corpoDoBloco(origem: string, seletor: string): string {
  const inicio = origem.indexOf(seletor);
  if (inicio < 0) throw new Error(`bloco não encontrado: ${seletor}`);
  const abre = origem.indexOf("{", inicio + seletor.replace(/\{$/, "").length);
  let nivel = 0;
  for (let i = abre; i < origem.length; i++) {
    if (origem[i] === "{") nivel++;
    if (origem[i] === "}") nivel--;
    if (nivel === 0) return origem.slice(abre + 1, i);
  }
  throw new Error(`bloco sem fechamento: ${seletor}`);
}

function declaracoes(corpo: string): Map<string, string> {
  const sem = corpo.replace(/\/\*[\s\S]*?\*\//g, "");
  const mapa = new Map<string, string>();
  for (const [, nome, valor] of sem.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    mapa.set(nome as string, (valor as string).trim());
  }
  return mapa;
}

describe("tema escuro: os dois blocos de tokens são idênticos", () => {
  const media = corpoDoBloco(css, "@media (prefers-color-scheme: dark)");
  const porPreferencia = declaracoes(corpoDoBloco(media, ":root:not([data-tema])"));
  const porEscolha = declaracoes(corpoDoBloco(css, ':root[data-tema="escuro"]'));

  it("controle positivo: os blocos foram lidos e trazem os tokens do contrato", () => {
    expect(porPreferencia.size).toBeGreaterThanOrEqual(13);
    expect(porEscolha.size).toBeGreaterThanOrEqual(13);
    expect(porEscolha.get("--paper")).toBe("#15161A");
    expect(porEscolha.get("--rubric")).toBe("#EE8A7A");
    expect(porEscolha.get("color-scheme")).toBeUndefined();
  });

  it("mesmos nomes e mesmos valores", () => {
    expect([...porPreferencia.keys()].sort()).toEqual([...porEscolha.keys()].sort());
    for (const [nome, valor] of porPreferencia) {
      expect(porEscolha.get(nome), nome).toBe(valor);
    }
  });

  it("os dois declaram color-scheme: dark", () => {
    const aviso = (corpo: string) => /color-scheme\s*:\s*dark\s*;/.test(corpo);
    expect(aviso(corpoDoBloco(media, ":root:not([data-tema])"))).toBe(true);
    expect(aviso(corpoDoBloco(css, ':root[data-tema="escuro"]'))).toBe(true);
  });

  it("o acento e o fundo claros são os do contrato", () => {
    const claro = declaracoes(corpoDoBloco(css, ":root {"));
    expect(claro.get("--rubric")).toBe("#9B1C1C");
    expect(claro.get("--paper")).toBe("#FAFAF7");
  });
});

describe("preferências vindas do cookie", () => {
  const cookies = (valores: Record<string, string>) => ({
    get: (nome: string) => (nome in valores ? { value: valores[nome] as string } : undefined),
  });

  it("sem cookie: sem tema e passo Padrão", () => {
    expect(lerPreferencias(cookies({}))).toEqual({ tema: null, passo: 2 });
  });

  it("aceita só os valores da lista", () => {
    expect(lerPreferencias(cookies({ tema: "escuro", "escala-texto": "5" }))).toEqual({
      tema: "escuro",
      passo: 5,
    });
    expect(lerPreferencias(cookies({ tema: "claro", "escala-texto": "1" }))).toEqual({
      tema: "claro",
      passo: 1,
    });
  });

  it("qualquer outro valor vira o padrão", () => {
    for (const ruim of ["", "0", "6", "2.5", "-1", "<script>", "escuro ", "1e1"]) {
      expect(lerPreferencias(cookies({ tema: ruim, "escala-texto": ruim }))).toEqual({
        tema: null,
        passo: 2,
      });
    }
  });

  it("as cinco escalas são as do contrato", () => {
    expect([...ESCALAS]).toEqual([0.9, 1, 1.15, 1.3, 1.5]);
  });
});
