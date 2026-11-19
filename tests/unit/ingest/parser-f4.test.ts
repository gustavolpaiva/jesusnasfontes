import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buscarArquivo,
  DIR_RAW,
  lerLock,
  lerRegistro,
  sha256,
  urlArquivo,
} from "../../../scripts/ingest/fontes";
import {
  carregarTabela,
  ErroF4,
  interpretarF4,
  mapaDePrefixos,
} from "../../../scripts/ingest/parser-f4";
import { chave, decompor } from "../../../src/modules/referencias/chave";

const mapa = mapaDePrefixos(carregarTabela());
const fixture = readFileSync(
  new URL("../../fixtures/biblia-livre/joao-trecho.txt", import.meta.url),
  "utf8",
);

describe("chave canônica", () => {
  it("João 3:16 é 43003016 e decompõe de volta", () => {
    expect(chave(43, 3, 16)).toBe(43003016);
    expect(decompor(43003016)).toEqual({ livro: 43, capitulo: 3, versiculo: 16 });
  });
  it("recusa faixas inválidas", () => {
    expect(() => chave(0, 1, 1)).toThrow(RangeError);
    expect(() => chave(67, 1, 1)).toThrow(RangeError);
    expect(() => chave(43, 0, 1)).toThrow(RangeError);
    expect(() => chave(43, 1, 1000)).toThrow(RangeError);
    expect(() => decompor(43000016)).toThrow(RangeError);
  });
});

describe("interpretarF4 sobre o trecho real de João", () => {
  const versiculos = interpretarF4(fixture, mapa);
  const por = (c: number) => versiculos.find((v) => v.chave === c);

  it("tira o BOM e reconhece os 11 versículos do capítulo 1 e o 3:16", () => {
    expect(fixture.charCodeAt(0)).toBe(0xfeff);
    expect(versiculos.map((v) => v.chave)).toEqual([
      ...Array.from({ length: 11 }, (_, i) => 43001001 + i),
      43003016,
    ]);
  });

  it("junta as linhas com um espaço e leva a nota (com \\key) para notas", () => {
    const v = por(43001001);
    expect(v?.texto).toBe(
      "No princípio era a Palavra, e a Palavra estava com Deus, e a Palavra era Deus.",
    );
    expect(v?.notas).toEqual([{ chave: "Palavra", texto: "Ou: o Verbo. Grego: Logos" }]);
  });

  it("mantém o trecho acrescentado no texto e o lista à parte", () => {
    const v = por(43001008);
    expect(v?.texto).toBe("Ele não era a Luz; mas veio para dar testemunho da Luz.");
    expect(v?.adicionados).toEqual(["veio"]);
  });

  it("junta linhas sem deixar espaço duplo e marca duvidoso só com « ou »", () => {
    const v = por(43003016);
    expect(v?.texto).toBe(
      "Porque Deus amou o mundo de tal maneira, que deu o seu Filho unigênito, para que todo aquele que nele crê não pereça, mas tenha a vida eterna.",
    );
    expect(v?.duvidoso).toBe(false);
    const d = interpretarF4("\\v Joao.5.4\n«\nAlgo duvidoso\n»\n", mapa);
    expect(d[0]?.duvidoso).toBe(true);
  });

  it("recusa marcador desconhecido, nomeando a linha", () => {
    const quebrado = fixture.replace("\\added", "\\inventado");
    expect(() => interpretarF4(quebrado, mapa)).toThrow(ErroF4);
    expect(() => interpretarF4(quebrado, mapa)).toThrow(
      /marcador desconhecido: \\inventado \(linha \d+\)/,
    );
  });

  it("recusa prefixo de livro desconhecido e nota sem fechamento", () => {
    expect(() => interpretarF4("\\v Xx.1.1\ntexto\n", mapa)).toThrow(
      /prefixo de livro desconhecido/,
    );
    expect(() => interpretarF4("\\v Joao.1.1\n\\fn\nnota\n\\v Joao.1.2\nx\n", mapa)).toThrow(
      ErroF4,
    );
  });
});

describe("João inteiro no commit fixado (rede, com cache em data/raw)", () => {
  it("passa pelo checksum do lock e acha 21 capítulos e o versículo 43003016", async () => {
    const lock = await lerLock();
    const registro = await lerRegistro();
    const esperado = lock.arquivos["n4/joao.txt"];
    expect(esperado).toMatch(/^[0-9a-f]{64}$/);
    const r = await buscarArquivo(
      urlArquivo("n4", "joao.txt"),
      path.join(DIR_RAW, "n4", "joao.txt"),
      esperado,
    );
    expect(sha256(r.conteudo)).toBe(esperado);
    const correcoes = registro.correcoes_marcacao.filter(
      (c) => c.edicao === "n4" && c.arquivo === "joao.txt",
    );
    const vs = interpretarF4(new TextDecoder().decode(r.conteudo), mapa, correcoes);
    const capitulos = new Set(vs.map((v) => decompor(v.chave).capitulo));
    expect(capitulos.size).toBe(21);
    expect(vs.length).toBe(879);
    expect(vs.some((v) => v.chave === 43003016)).toBe(true);
  }, 60_000);
});
