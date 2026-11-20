import { describe, expect, it } from "vitest";
import {
  ErroAfirmacao,
  extrairAfirmacoes,
  PADRAO_ID_AFIRMACAO,
  textoDaAfirmacao,
} from "../../../scripts/content/afirmacoes";

// A11 da pesquisa: a sintaxe `:afirmacao[texto]{#id}` com unified, remark-parse e remark-directive.

describe("extrairAfirmacoes", () => {
  it("extrai id e texto, na ordem em que aparecem, e agrupa pelo parágrafo que as contém", () => {
    const md = [
      "## O ponto",
      "",
      "Antes :afirmacao[Marcos escreveu primeiro]{#bh04-a1} depois.",
      "",
      "- :afirmacao[Pilatos governou de 26 a 36]{#bh04-a2}",
      "- Sem marca nesta linha.",
      "- :afirmacao[Um]{#bh04-a3} e :afirmacao[dois]{#bh04-a4} no mesmo item.",
    ].join("\n");
    const r = extrairAfirmacoes(md);
    expect(r.map((a) => [a.id, a.texto, a.ordem])).toEqual([
      ["bh04-a1", "Marcos escreveu primeiro", 1],
      ["bh04-a2", "Pilatos governou de 26 a 36", 2],
      ["bh04-a3", "Um", 3],
      ["bh04-a4", "dois", 4],
    ]);
    // a3 e a4 estão no mesmo item de lista (mesmo bloco); a1 e a2 em blocos diferentes
    expect(r[2]?.bloco).toBe(r[3]?.bloco);
    expect(new Set(r.map((a) => a.bloco)).size).toBe(3);
  });

  it("não confunde dois-pontos comuns, horas e referências bíblicas com diretiva", () => {
    const md = "Veja Mt 3:13 e Jo 3:16. Gênero: biografia. Às 12:30 e (d.C.): fim. Ex.: isto.";
    expect(extrairAfirmacoes(md)).toEqual([]);
  });

  it("guarda formatação dentro da frase como texto puro", () => {
    const r = extrairAfirmacoes(":afirmacao[o **dado** é *este*]{#pc03-a1}");
    expect(r[0]?.texto).toBe("o dado é este");
  });

  it("falha em id repetido", () => {
    const md = ":afirmacao[a]{#bh01-a1}\n\n:afirmacao[b]{#bh01-a1}";
    expect(() => extrairAfirmacoes(md)).toThrow(/id repetido.*bh01-a1/);
  });

  it.each(["bh1-a1", "BH01-a1", "xx01-a1", "bh01-a", "bh01-a0x", "bh001-a1", "bh01_a1", "pc01-b1"])(
    "falha em id fora do padrão: %s",
    (id) => {
      expect(PADRAO_ID_AFIRMACAO.test(id)).toBe(false);
      expect(() => extrairAfirmacoes(`:afirmacao[a]{#${id}}`)).toThrow(ErroAfirmacao);
    },
  );

  it("aceita os dois prefixos e números de mais de um dígito", () => {
    expect(PADRAO_ID_AFIRMACAO.test("bh03-a1")).toBe(true);
    expect(PADRAO_ID_AFIRMACAO.test("pc17-a12")).toBe(true);
  });

  it("falha sem id, com atributo a mais, vazia, aninhada ou com outra diretiva", () => {
    expect(() => extrairAfirmacoes(":afirmacao[a]")).toThrow(/sem id/);
    expect(() => extrairAfirmacoes(":afirmacao[a]{#bh01-a1 .x}")).toThrow(/atributo/);
    expect(() => extrairAfirmacoes(":afirmacao[]{#bh01-a1}")).toThrow(/vazia/);
    expect(() => extrairAfirmacoes(":afirmacao[a :afirmacao[b]{#bh01-a2}]{#bh01-a1}")).toThrow(
      /dentro de outra/,
    );
    expect(() => extrairAfirmacoes("texto :outra[a]{#bh01-a1}")).toThrow(/diretiva desconhecida/);
    expect(() => extrairAfirmacoes("::afirmacao[a]{#bh01-a1}")).toThrow(/diretiva de texto/);
    expect(() => extrairAfirmacoes(":::afirmacao\ncorpo\n:::")).toThrow(/diretiva de texto/);
  });

  it("falha fora de parágrafo (título)", () => {
    expect(() => extrairAfirmacoes("## :afirmacao[a]{#bh01-a1}")).toThrow(/fora de parágrafo/);
  });

  it("o hash do texto muda quando o texto muda e não muda quando só o id muda", () => {
    expect(textoDaAfirmacao("uma frase")).toBe(textoDaAfirmacao("uma frase"));
    expect(textoDaAfirmacao("uma frase")).not.toBe(textoDaAfirmacao("uma frase."));
    expect(textoDaAfirmacao("uma frase")).toMatch(/^[0-9a-f]{64}$/);
  });
});
