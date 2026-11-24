import { describe, expect, it } from "vitest";
import { esquemaFonteFormulario, slugDoTitulo } from "@/modules/acervo/schemas-painel";
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

describe("o `cid` derivado cabe no contrato do esquema para QUALQUER id que o banco gere (revisão cruzada, MÉDIA)", () => {
  // O esquema do painel (`esquemaFonteFormulario`) é o que decide se a página de edição consegue salvar.
  const base = {
    modo: "editar" as const,
    slug: "x",
    titulo: "T",
    nivel: "primaria" as const,
    idioma: "pt" as const,
    tipo_texto: "integral" as const,
    obra_protegida: false,
    traduzida_por_nos: false,
    publicada: false,
    revisao: 0,
    autor: "",
    epoca: "",
    tradicao: "",
    origem_nome: "",
    origem_url: "",
    licenca: "",
    licenca_url: "",
    tradutor: "",
    traducao_ano: "",
    edicao: "",
    limites_pt: "",
  };
  const aceita = (secao: SecaoEmEdicao) =>
    esquemaFonteFormulario.safeParse({ ...base, secoes: [secao] }).success;
  const persistida = (id: string): SecaoPersistida => ({
    id,
    versao: V1,
    titulo: "S",
    texto: "Texto.",
    resumoPt: null,
    palavrasChavePt: [],
  });

  it("Fonte com título de 60 letras `a` e uma seção: a seção persistida da página de edição passa no esquema", () => {
    const slug = slugDoTitulo("a".repeat(60));
    expect(slug).toHaveLength(60);
    const [secao] = secoesIniciais([persistida(`${slug}/secao-1`)]);
    expect(secao?.cid.length).toBeLessThanOrEqual(64);
    expect(aceita(secao as SecaoEmEdicao)).toBe(true);
  });

  it("controle: a derivação anterior (id com barras trocadas por hífen) estourava 64 neste mesmo caso e o esquema a recusava", () => {
    const id = `${"a".repeat(60)}/secao-1`;
    const antiga = `p-${id.replace(/[^A-Za-z0-9]+/g, "-")}`;
    expect(antiga).toHaveLength(70);
    const linhaAntiga = { ...secoesIniciais([persistida(id)])[0], cid: antiga } as SecaoEmEdicao;
    expect(aceita(linhaAntiga)).toBe(false);
  });

  it("propriedade: ids de qualquer tamanho que o banco gera (Fonte até 120 + '/' + seção até 80) dão `cid` de tamanho limitado, determinístico, seguro e aceito", () => {
    const tamanhos = [1, 2, 7, 30, 59, 60, 61, 100, 120];
    const secoes = ["secao-1", "secao-60", `s${"b".repeat(79)}`];
    const vistos = new Set<string>();
    for (const t of tamanhos) {
      for (const s of secoes) {
        const id = `${"a".repeat(t)}/${s}`;
        const [linhaInicial] = secoesIniciais([persistida(id)]);
        const cid = linhaInicial?.cid ?? "";
        expect(cid.length).toBeGreaterThan(2);
        expect(cid.length).toBeLessThanOrEqual(24);
        expect(cid).toMatch(/^[A-Za-z0-9-]+$/);
        expect(cidDaSecaoPersistida(id)).toBe(cid); // determinístico
        expect(aceita(linhaInicial as SecaoEmEdicao)).toBe(true);
        expect(vistos.has(cid)).toBe(false); // ids diferentes, `cid` diferentes
        vistos.add(cid);
      }
    }
  });

  it("as 60 seções de uma Fonte de título longo têm `cid` distintos", () => {
    const slug = slugDoTitulo("a".repeat(300));
    const ids = Array.from({ length: 60 }, (_, i) => `${slug}/secao-${i + 1}`);
    const cids = secoesIniciais(ids.map(persistida)).map((s) => s.cid);
    expect(new Set(cids).size).toBe(60);
  });

  it("o `cid` de linha criada no navegador também passa no esquema, mesmo depois de muitas linhas", () => {
    for (let i = 0; i < 2000; i += 1) novoCid();
    const [secao] = secoesIniciais([persistida("f/secao-1")]);
    expect(
      aceita({ ...(secao as SecaoEmEdicao), id: undefined, versao: undefined, cid: novoCid() }),
    ).toBe(true);
  });
});
