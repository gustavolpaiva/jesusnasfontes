import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
  carregarFontes,
  executarCarga,
  TETO_SECAO_CARACTERES,
} from "../../../scripts/acervo/carregar";
import type { Derivado, FonteYaml } from "../../../src/modules/acervo/schemas";
import { interpretarFonteYaml } from "../../../src/modules/acervo/schemas";
import { yamlSha256DoArquivo } from "../../support/entrada";

// Pitfall 9: uma seção acima de 80.000 caracteres de texto estoura a página de leitura no celular. O
// carregador recusa ANTES de abrir a transação, nomeando a Fonte e a seção; a Fonte pode registrar um teto
// próprio (`secao_max_caracteres`) COM motivo, e a exceção é impressa no relatório da carga.

const SENTINELA = "SENTINELA: a transação não devia abrir neste teste";

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const fonteBase = `
slug: fonte-x
titulo: Fonte de teste
nivel: primaria
tipo_texto: ficha
idioma: pt
publicada: false
`;

function fonte(extra = ""): FonteYaml {
  return interpretarFonteYaml(fonteBase + extra, "fonte-x.yaml");
}

function derivado(texto: string, slugSecao = "secao-1"): Derivado {
  return {
    versao_formato: 1,
    slug: "fonte-x",
    idioma: "pt",
    origem_id: "origem-teste",
    origem_sha256: "a".repeat(64),
    gerado_por: "teste",
    secoes: [
      { slug: slugSecao, titulo: "Seção de teste", ordem: 1, paragrafos: [{ ref: "1", texto }] },
    ],
  };
}

/** Cliente de mentira: qualquer query lança a sentinela; as chamadas ficam gravadas. */
function clienteFalso(): { cliente: pg.Client; chamadas: string[] } {
  const chamadas: string[] = [];
  const cliente = {
    query: (q: string) => {
      chamadas.push(q);
      return Promise.reject(new Error(SENTINELA));
    },
  } as unknown as pg.Client;
  return { cliente, chamadas };
}

describe("teto de seção no carregador (80.000 caracteres, Pitfall 9)", () => {
  it("recusa seção acima do teto ANTES de abrir a transação, nomeando Fonte e seção", async () => {
    const { cliente, chamadas } = clienteFalso();
    const texto = "x".repeat(TETO_SECAO_CARACTERES + 1);
    const erro = await carregarFontes(
      [{ fonte: fonte(), derivado: derivado(texto, "secao-grande") }],
      { cliente },
    ).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toContain("Fonte fonte-x");
    expect((erro as Error).message).toContain("secao-grande");
    expect((erro as Error).message).toContain("80.001");
    expect(chamadas).toHaveLength(0); // nenhuma query: nem o "begin"
  });

  it("aceita seção abaixo do teto (a recusa não dispara e a transação abriria)", async () => {
    const { cliente, chamadas } = clienteFalso();
    const texto = "x".repeat(TETO_SECAO_CARACTERES);
    const erro = await carregarFontes([{ fonte: fonte(), derivado: derivado(texto) }], {
      cliente,
    }).catch((e: Error) => e);
    expect((erro as Error).message).toBe(SENTINELA);
    expect(chamadas[0]).toBe("begin");
  });

  it("a Fonte pode registrar teto próprio com motivo (secao_max_caracteres)", async () => {
    const comExcecao = fonte(`
secao_max_caracteres:
  caracteres: 90000
  motivo: "seção de leitura contínua conferida no UI-SPEC"
`);
    const { cliente } = clienteFalso();
    const texto = "x".repeat(85_000);
    const erro = await carregarFontes([{ fonte: comExcecao, derivado: derivado(texto) }], {
      cliente,
    }).catch((e: Error) => e);
    expect((erro as Error).message).toBe(SENTINELA); // passou pelo teto próprio
  });

  it("o teto próprio também é limite: acima dele a seção é recusada", async () => {
    const comExcecao = fonte(`
secao_max_caracteres:
  caracteres: 90000
  motivo: "seção de leitura contínua conferida no UI-SPEC"
`);
    const { cliente, chamadas } = clienteFalso();
    const texto = "x".repeat(90_001);
    const erro = await carregarFontes([{ fonte: comExcecao, derivado: derivado(texto) }], {
      cliente,
    }).catch((e: Error) => e);
    expect((erro as Error).message).toContain("90.001");
    expect((erro as Error).message).toContain("90.000");
    expect(chamadas).toHaveLength(0);
  });

  it("a exceção registrada é impressa no relatório da carga, com o motivo", async () => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-teto-secao-"));
    temporarios.push(raiz);
    const fontes = path.join(raiz, "fontes");
    const derivados = path.join(raiz, "derivados");
    mkdirSync(fontes);
    mkdirSync(derivados);
    const d = derivado("x".repeat(85_000));
    const json = JSON.stringify(d);
    writeFileSync(path.join(derivados, "fonte-x.json"), json);
    writeFileSync(
      path.join(fontes, "fonte-x.yaml"),
      `${fonteBase}
secao_max_caracteres:
  caracteres: 90000
  motivo: "seção de leitura contínua conferida no UI-SPEC"
`,
    );
    writeFileSync(
      path.join(raiz, "lock.json"),
      JSON.stringify({
        orcamento_arquivo_bytes: 10_000_000,
        orcamento_total_bytes: 10_000_000,
        derivados: {
          "fonte-x": {
            sha256: createHash("sha256").update(json).digest("hex"),
            bytes: Buffer.byteLength(json),
            yaml_sha256: yamlSha256DoArquivo(path.join(fontes, "fonte-x.yaml")),
            revisao: 1,
          },
        },
      }),
    );
    const linhas: string[] = [];
    await executarCarga(
      { fontes, derivados, lock: path.join(raiz, "lock.json") },
      { abrir: () => Promise.resolve(clienteFalso().cliente), escrever: (l) => linhas.push(l) },
    ).catch(() => {});
    const excecao = linhas.find((l) => l.includes("exceção de teto"));
    expect(excecao).toContain("fonte-x");
    expect(excecao).toContain("90000");
    expect(excecao).toContain("leitura contínua");
  });
});
