import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARQUIVO_DA_CARTA, lerCarta, pastaDaCarta } from "@/modules/acervo/carta";

// Leitura da carta de neutralidade (D-08, T-02-40): o texto é do dono e só existe quando ele o publica. Cada caso usa
// uma pasta de fixture; o texto de teste é inventado.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
  "carta",
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("lerCarta", () => {
  it("pasta sem o arquivo: null, sem erro no registro (a carta ainda não foi publicada)", () => {
    const vazia = mkdtempSync(path.join(tmpdir(), "carta-vazia-"));
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(lerCarta(vazia)).toBeNull();
      expect(erro).not.toHaveBeenCalled();
    } finally {
      rmSync(vazia, { recursive: true, force: true });
    }
  });

  it("pasta que não existe: null", () => {
    expect(lerCarta(path.join(FIXTURES, "nao-existe"))).toBeNull();
  });

  it("carta válida: título, versão, data, abertura e seções com os parágrafos", () => {
    const carta = lerCarta(path.join(FIXTURES, "valida"));
    expect(carta).not.toBeNull();
    expect(carta).toMatchObject({
      titulo: "Carta de neutralidade",
      versao: "1",
      data: "2026-11-24",
    });
    expect(carta?.lede).toHaveLength(2);
    expect(carta?.secoes.map((s) => s.titulo)).toEqual([
      "Critério de entrada",
      "O que ficou de fora",
    ]);
    // Linhas seguidas viram um parágrafo só; a linha em branco separa.
    expect(carta?.secoes[0]?.paragrafos).toEqual([
      "Primeiro parágrafo da seção de teste, escrito em duas linhas que viram um parágrafo só.",
      "Segundo parágrafo da seção de teste.",
    ]);
  });

  it("Markdown restrito: marcação HTML e asteriscos ficam como texto literal", () => {
    const carta = lerCarta(path.join(FIXTURES, "valida"));
    expect(carta?.lede[1]).toContain('<b id="intruso">marcação</b>');
    expect(carta?.secoes[1]?.paragrafos[0]).toContain("**asteriscos**");
  });

  it("cabeçalho inválido: null, e o registro de erro leva só o contexto e a classe, nunca o texto", () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(lerCarta(path.join(FIXTURES, "cabecalho-invalido"))).toBeNull();
    expect(erro).toHaveBeenCalledTimes(1);
    const linha = String(erro.mock.calls[0]?.[0]);
    expect(linha).toContain("acervo-carta");
    expect(linha).not.toContain("SEGREDO-DA-CARTA-DE-TESTE");
    expect(linha).not.toContain("ontem");
  });

  it("arquivo sem cabeçalho: null, sem o texto no registro", () => {
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(lerCarta(path.join(FIXTURES, "sem-cabecalho"))).toBeNull();
    expect(String(erro.mock.calls[0]?.[0])).not.toContain("SEGREDO-DA-CARTA-DE-TESTE");
  });

  it("campo desconhecido no cabeçalho e data fora do formato são recusados", () => {
    const pasta = mkdtempSync(path.join(tmpdir(), "carta-campo-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      writeFileSync(
        path.join(pasta, ARQUIVO_DA_CARTA),
        "---\ntitulo: T\nversao: 1\ndata: 2026-11-24\nextra: x\n---\nTexto.\n",
      );
      expect(lerCarta(pasta)).toBeNull();
      writeFileSync(
        path.join(pasta, ARQUIVO_DA_CARTA),
        "---\ntitulo: T\nversao: 1\ndata: 24/11/2026\n---\nTexto.\n",
      );
      expect(lerCarta(pasta)).toBeNull();
      // Controle positivo: versão numérica e data como data do YAML são aceitas.
      writeFileSync(
        path.join(pasta, ARQUIVO_DA_CARTA),
        "---\ntitulo: T\nversao: 2\ndata: 2026-11-24\n---\nTexto.\n",
      );
      expect(lerCarta(pasta)).toMatchObject({ versao: "2", data: "2026-11-24", lede: ["Texto."] });
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe("pastaDaCarta", () => {
  it("padrão: content/acervo dentro do projeto", () => {
    vi.stubEnv("CARTA_DIR_PARA_TESTE", "");
    expect(pastaDaCarta()).toBe(path.join(process.cwd(), "content", "acervo"));
  });

  it("o desvio de teste vale fora de produção e é ignorado em produção", () => {
    vi.stubEnv("CARTA_DIR_PARA_TESTE", "/tmp/fixture-de-carta");
    vi.stubEnv("NODE_ENV", "test");
    expect(pastaDaCarta()).toBe("/tmp/fixture-de-carta");
    vi.stubEnv("NODE_ENV", "production");
    expect(pastaDaCarta()).toBe(path.join(process.cwd(), "content", "acervo"));
  });
});
