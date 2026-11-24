import { describe, expect, it } from "vitest";
import {
  aplicarSalvamento,
  novoCid,
  type SecaoEmEdicao,
} from "@/modules/acervo/secoes-do-formulario";

// A resposta do servidor é casada com as linhas do formulário pelo `cid`, nunca pela posição (2ª revisão cruzada do plano
// 02-17): remover uma linha enquanto o pedido está no ar não pode dar à vizinha o endereço da removida.

const linha = (cid: string, titulo: string, parte: Partial<SecaoEmEdicao> = {}): SecaoEmEdicao => ({
  cid,
  titulo,
  texto: `Texto de ${titulo}.`,
  resumo_pt: "",
  palavras_chave_pt: "",
  ...parte,
});

describe("casamento da resposta com as linhas do formulário", () => {
  it("cada linha recebe o endereço e a revisão da SUA resposta", () => {
    const atuais = [linha("a", "A"), linha("b", "B")];
    const r = aplicarSalvamento(atuais, [
      { cid: "a", slug: "secao-1", revisao: 0 },
      { cid: "b", slug: "secao-2", revisao: 0 },
    ]);
    expect(r.map((l) => [l.cid, l.slug])).toEqual([
      ["a", "secao-1"],
      ["b", "secao-2"],
    ]);
  });

  it("A e B enviadas, A removida durante o pedido: B fica com o endereço de B, não com o de A", () => {
    const enviadas = [linha("a", "A"), linha("b", "B")];
    const respostas = [
      { cid: "a", slug: "secao-1", revisao: 0 },
      { cid: "b", slug: "secao-2", revisao: 0 },
    ];
    // Durante o voo a linha A saiu da lista (o que o casamento por posição não suporta).
    const atuais = enviadas.filter((l) => l.cid !== "a");
    const r = aplicarSalvamento(atuais, respostas);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cid: "b", titulo: "B", slug: "secao-2" });
    // O casamento por posição, que era o defeito, daria o endereço de A a B: o controle prova que o teste o enxerga.
    const porPosicao = atuais.map((l, i) => ({ ...l, slug: respostas[i]?.slug }));
    expect(porPosicao[0]?.slug).toBe("secao-1");
  });

  it("linha nova adicionada durante o pedido não recebe endereço de ninguém", () => {
    const atuais = [linha("a", "A"), linha("c", "C (nova, adicionada no voo)")];
    const r = aplicarSalvamento(atuais, [{ cid: "a", slug: "secao-1", revisao: 0 }]);
    expect(r[0]).toMatchObject({ cid: "a", slug: "secao-1" });
    expect(r[1]?.slug).toBeUndefined();
    expect(r[1]?.revisao).toBeUndefined();
  });

  it("resposta de linha que já não existe é descartada; a ordem das linhas não muda", () => {
    const atuais = [linha("b", "B"), linha("c", "C")];
    const r = aplicarSalvamento(atuais, [
      { cid: "c", slug: "secao-3", revisao: 2 },
      { cid: "x", slug: "secao-9", revisao: 0 },
    ]);
    expect(r.map((l) => l.cid)).toEqual(["b", "c"]);
    expect(r[0]?.slug).toBeUndefined();
    expect(r[1]).toMatchObject({ slug: "secao-3", revisao: 2 });
  });

  it("o que o usuário digitou durante o pedido continua: só endereço e revisão mudam", () => {
    const atuais = [linha("a", "A editada no voo", { texto: "Texto novo." })];
    const r = aplicarSalvamento(atuais, [{ cid: "a", slug: "secao-1", revisao: 4 }]);
    expect(r[0]).toMatchObject({
      titulo: "A editada no voo",
      texto: "Texto novo.",
      slug: "secao-1",
      revisao: 4,
    });
  });

  it("novoCid nunca repete", () => {
    const vistos = new Set(Array.from({ length: 1000 }, () => novoCid()));
    expect(vistos.size).toBe(1000);
  });
});
