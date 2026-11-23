import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashDaFicha, hashDoItem, itensDaFicha } from "@/modules/acervo/hash-ficha";
import { ErroContrato, interpretarFichaYaml, interpretarPagina } from "@/modules/acervo/schemas";

// Contrato da ficha e hash canônico. A ficha só entra como rascunho (D-03, D-17); o erro de contrato carrega o
// nome do campo, nunca o texto da ficha.

const PASTA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
  "rascunhos",
  "fichas",
);
const fixture = (nome = "obra-de-teste.yaml") => readFileSync(path.join(PASTA, nome), "utf8");
const ler = (yaml: string) => interpretarFichaYaml(yaml, "obra-de-teste.yaml");
/** Acrescenta ou troca uma linha de primeiro nível do YAML. */
const comLinha = (yaml: string, chave: string, valor: string) =>
  yaml.match(new RegExp(`^${chave}:`, "m"))
    ? yaml.replace(new RegExp(`^${chave}:.*$`, "m"), `${chave}: ${valor}`)
    : `${yaml}\n${chave}: ${valor}\n`;

describe("contrato da ficha", () => {
  it("aceita a ficha de teste e a que tem a edição pendente", () => {
    const f = ler(fixture());
    expect(f.estado).toBe("rascunho");
    expect(f.itens).toHaveLength(3);
    const pendente = ler(fixture("obra-de-teste-edicao-pendente.yaml"));
    expect(pendente.edicao_consultada.startsWith("A confirmar: ")).toBe(true);
    expect(f.edicao_consultada.startsWith("A confirmar")).toBe(false);
  });

  it.each(["verificada", "conferida", "publicada"])(
    "recusa estado '%s', dizendo o nome do campo",
    (estado) => {
      expect(() => ler(comLinha(fixture(), "estado", estado))).toThrow(/estado/);
      expect(() => ler(comLinha(fixture(), "estado", estado))).toThrow(ErroContrato);
    },
  );

  it.each(["verificada_em", "verificada_por", "verificada", "conferida_em", "ficha_hash"])(
    "recusa o campo de verificação '%s' no YAML",
    (campo) => {
      expect(() => ler(comLinha(fixture(), campo, "true"))).toThrow(
        new RegExp(`campo desconhecido: ${campo}`),
      );
    },
  );

  it("recusa item que traz campo de verificação", () => {
    const yaml = fixture().replace(
      "    confianca: media",
      "    confianca: media\n    conferida: true",
    );
    expect(() => ler(yaml)).toThrow(/itens\.0: campo desconhecido: conferida/);
  });

  it("recusa estado ausente: a ficha DECLARA que é rascunho", () => {
    expect(() => ler(fixture().replace(/^estado: rascunho\n/m, ""))).toThrow(/estado/);
  });

  it("recusa argumento e trecho sem página", () => {
    const yaml = fixture().replace('    pagina: "10"\n', "");
    expect(() => ler(yaml)).toThrow(/itens\.0\.pagina/);
    const vazio = fixture().replace('    pagina: "10"', '    pagina: ""');
    expect(() => ler(vazio)).toThrow(/itens\.0\.pagina/);
  });

  it("recusa trecho_original com 301 caracteres, antes do banco, e aceita 300", () => {
    const com = (n: number) =>
      fixture().replace(
        "This is an invented test sentence, not taken from any book.",
        "x".repeat(n),
      );
    expect(() => ler(com(301))).toThrow(/itens\.2\.trecho_original/);
    expect(ler(com(300)).itens[2]?.trecho_original).toHaveLength(300);
  });

  it("recusa texto_pt de item com mais de 2000 caracteres", () => {
    const yaml = fixture().replace("Primeiro argumento de teste, em português.", "y".repeat(2001));
    expect(() => ler(yaml)).toThrow(/itens\.0\.texto_pt/);
  });

  it("recusa edição consultada vazia, slug fora do padrão e ficha sem item", () => {
    expect(() => ler(comLinha(fixture(), "edicao_consultada", '"   "'))).toThrow(
      /edicao_consultada/,
    );
    expect(() => ler(comLinha(fixture(), "slug", "Obra_De_Teste"))).toThrow(/slug/);
    expect(() => ler(fixture().replace(/^itens:[\s\S]*$/m, "itens: []"))).toThrow(/itens/);
  });

  it("recusa trecho_original com idioma de trechos que não é pt nem en", () => {
    expect(() => ler(comLinha(fixture(), "idioma_trechos", "fr"))).toThrow(/idioma_trechos/);
  });

  it("a mensagem de erro nunca traz o texto da ficha", () => {
    let mensagem = "";
    try {
      ler(comLinha(fixture(), "estado", "verificada"));
    } catch (erro) {
      mensagem = (erro as Error).message;
    }
    expect(mensagem).not.toContain("Primeiro argumento");
    expect(mensagem).not.toContain("Tradução do trecho");
  });
});

describe("página do item", () => {
  it("número vira faixa inteira; faixa numérica também; o resto fica como texto", () => {
    expect(interpretarPagina("39")).toEqual({ inicio: 39, fim: 39, texto: null });
    expect(interpretarPagina("39-53")).toEqual({ inicio: 39, fim: 53, texto: null });
    expect(interpretarPagina("xi-xii")).toEqual({ inicio: null, fim: null, texto: "xi-xii" });
    expect(interpretarPagina("12a")).toEqual({ inicio: null, fim: null, texto: "12a" });
  });

  it("faixa numérica invertida é recusada pelo contrato", () => {
    const yaml = fixture().replace('pagina: "12-14"', 'pagina: "14-12"');
    expect(() => ler(yaml)).toThrow(/itens\.1\.pagina/);
  });
});

describe("hash canônico", () => {
  const montar = (yaml: string) => {
    const f = ler(yaml);
    const itens = itensDaFicha(f);
    return { f, itens, hashItens: itens.map(hashDoItem), hashFicha: hashDaFicha(f, itens) };
  };

  it("é hexadecimal de 64 caracteres e estável entre leituras", () => {
    const a = montar(fixture());
    const b = montar(fixture());
    expect(a.hashFicha).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hashFicha).toBe(b.hashFicha);
    expect(a.hashItens).toEqual(b.hashItens);
  });

  it("os ids dos itens são <slug>/<tipo>-<n>, pela ordem dentro do tipo", () => {
    const { itens } = montar(fixture());
    expect(itens.map((i) => i.id)).toEqual([
      "obra-de-teste/argumento-1",
      "obra-de-teste/argumento-2",
      "obra-de-teste/trecho-1",
    ]);
  });

  it("mudar o texto de um item muda o hash dele e o da ficha, e só o dele", () => {
    const antes = montar(fixture());
    const depois = montar(
      fixture().replace("Segundo argumento de teste", "Segundo argumento de teste, alterado"),
    );
    expect(depois.hashItens[0]).toBe(antes.hashItens[0]);
    expect(depois.hashItens[1]).not.toBe(antes.hashItens[1]);
    expect(depois.hashItens[2]).toBe(antes.hashItens[2]);
    expect(depois.hashFicha).not.toBe(antes.hashFicha);
  });

  it("a página faz parte do hash do item", () => {
    const antes = montar(fixture());
    const depois = montar(fixture().replace('pagina: "10"', 'pagina: "11"'));
    expect(depois.hashItens[0]).not.toBe(antes.hashItens[0]);
    expect(depois.hashFicha).not.toBe(antes.hashFicha);
  });

  it("mudar a edição consultada ou a tese muda o hash da ficha mas não o dos itens", () => {
    const antes = montar(fixture());
    for (const [chave, valor] of [
      ["edicao_consultada", "Outra edição de teste"],
      ["tese_pt", "Outra tese de teste."],
    ] as const) {
      const depois = montar(comLinha(fixture(), chave, valor));
      expect(depois.hashItens, chave).toEqual(antes.hashItens);
      expect(depois.hashFicha, chave).not.toBe(antes.hashFicha);
    }
  });

  it("a confiança do rascunho e o campo serve_a não entram no hash", () => {
    const antes = montar(fixture());
    const depois = montar(
      fixture().replace("confianca: media", "confianca: alta").replace("bh00-a0", "bh00-a1"),
    );
    expect(depois.hashItens).toEqual(antes.hashItens);
    expect(depois.hashFicha).toBe(antes.hashFicha);
  });
});
