import { describe, expect, it } from "vitest";
import {
  aplicarSalvamento,
  cidDaSecaoPersistida,
  novoCid,
  type SecaoEmEdicao,
  type SecaoPersistida,
  secoesIniciais,
} from "@/modules/acervo/secoes-do-formulario";

// Casamento da resposta com as linhas por `cid` (nunca pela posição) e `cid` inicial determinístico (revisões cruzadas do
// plano 02-17).

const linha = (cid: string, titulo: string, parte: Partial<SecaoEmEdicao> = {}): SecaoEmEdicao => ({
  cid,
  titulo,
  texto: `Texto de ${titulo}.`,
  resumo_pt: "",
  palavras_chave_pt: "",
  ...parte,
});
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";

describe("casamento da resposta com as linhas do formulário", () => {
  it("cada linha recebe o id e a versão da SUA resposta", () => {
    const r = aplicarSalvamento(
      [linha("a", "A"), linha("b", "B")],
      [
        { cid: "a", id: "f/secao-1", versao: V1 },
        { cid: "b", id: "f/secao-2", versao: V2 },
      ],
    );
    expect(r.map((l) => [l.cid, l.id, l.versao])).toEqual([
      ["a", "f/secao-1", V1],
      ["b", "f/secao-2", V2],
    ]);
  });

  it("A e B enviadas, A removida durante o pedido: B fica com o id de B, não com o de A", () => {
    const enviadas = [linha("a", "A"), linha("b", "B")];
    const respostas = [
      { cid: "a", id: "f/secao-1", versao: V1 },
      { cid: "b", id: "f/secao-2", versao: V2 },
    ];
    const atuais = enviadas.filter((l) => l.cid !== "a");
    const r = aplicarSalvamento(atuais, respostas);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ cid: "b", titulo: "B", id: "f/secao-2", versao: V2 });
    // Controle: o casamento por posição, que era o defeito, daria o id de A a B (o teste enxerga o erro).
    const porPosicao = atuais.map((l, i) => ({ ...l, id: respostas[i]?.id }));
    expect(porPosicao[0]?.id).toBe("f/secao-1");
  });

  it("linha nova adicionada durante o pedido não recebe id de ninguém", () => {
    const r = aplicarSalvamento(
      [linha("a", "A"), linha("c", "C (nova, adicionada no voo)")],
      [{ cid: "a", id: "f/secao-1", versao: V1 }],
    );
    expect(r[0]).toMatchObject({ cid: "a", id: "f/secao-1" });
    expect(r[1]?.id).toBeUndefined();
    expect(r[1]?.versao).toBeUndefined();
  });

  it("resposta de linha que já não existe é descartada; a ordem não muda; o digitado no voo fica", () => {
    const r = aplicarSalvamento(
      [linha("b", "B"), linha("c", "C editada", { texto: "Novo." })],
      [
        { cid: "c", id: "f/secao-3", versao: V2 },
        { cid: "x", id: "f/secao-9", versao: V1 },
      ],
    );
    expect(r.map((l) => l.cid)).toEqual(["b", "c"]);
    expect(r[0]?.id).toBeUndefined();
    expect(r[1]).toMatchObject({ id: "f/secao-3", versao: V2, texto: "Novo." });
  });

  it("novoCid nunca repete", () => {
    expect(new Set(Array.from({ length: 1000 }, () => novoCid())).size).toBe(1000);
  });
});

describe("`cid` inicial determinístico (a hidratação não diverge)", () => {
  const persistidas: SecaoPersistida[] = [
    {
      id: "obra/secao-1",
      versao: V1,
      titulo: "A",
      texto: "A1.",
      resumoPt: null,
      palavrasChavePt: [],
    },
    {
      id: "obra/secao-2",
      versao: V2,
      titulo: null,
      texto: "B1.",
      resumoPt: "R",
      palavrasChavePt: ["x", "y"],
    },
  ];

  it("a mesma entrada dá os mesmos `cid` em duas chamadas (servidor e navegador) e eles não dependem de contador nem de relógio", () => {
    const servidor = secoesIniciais(persistidas).map((s) => s.cid);
    novoCid();
    novoCid(); // o navegador já criou linhas novas antes de a hidratação terminar: não muda os iniciais
    const navegador = secoesIniciais(persistidas).map((s) => s.cid);
    expect(navegador).toEqual(servidor);
    expect(servidor).toEqual([
      cidDaSecaoPersistida("obra/secao-1"),
      cidDaSecaoPersistida("obra/secao-2"),
    ]);
  });

  it("o `cid` é seguro como atributo de id (sem barra, espaço ou dois-pontos) e distinto por seção", () => {
    const cids = secoesIniciais(persistidas).map((s) => s.cid);
    for (const c of cids) expect(c).toMatch(/^[A-Za-z0-9-]+$/);
    expect(new Set(cids).size).toBe(2);
    // Ids que só diferem em pontuação não colidem a ponto de confundir duas seções do mesmo formulário.
    expect(cidDaSecaoPersistida("obra/secao-1")).not.toBe(cidDaSecaoPersistida("obra/secao-2"));
  });

  it("as linhas iniciais trazem id e versão do que o servidor leu", () => {
    const [a, b] = secoesIniciais(persistidas);
    expect(a).toMatchObject({ id: "obra/secao-1", versao: V1, titulo: "A", resumo_pt: "" });
    expect(b).toMatchObject({ titulo: "", palavras_chave_pt: "x, y", resumo_pt: "R" });
  });
});
