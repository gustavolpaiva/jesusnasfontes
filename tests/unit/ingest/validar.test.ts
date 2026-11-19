import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buscarArquivo, ErroChecksum, type Esperado, sha256 } from "../../../scripts/ingest/fontes";
import {
  carregarTabela,
  ErroF4,
  interpretarF4,
  mapaDePrefixos,
  type Versiculo,
} from "../../../scripts/ingest/parser-f4";
import { ErroValidacao, validarEdicao } from "../../../scripts/ingest/validar";

const mapa = mapaDePrefixos(carregarTabela());
const marcos5 = readFileSync(
  new URL("../../fixtures/biblia-livre/marcos-5.txt", import.meta.url),
  "utf8",
);

const esperado: Esperado = {
  versiculos: 31101,
  capitulos: 1189,
  excecoes: [{ tipo: "versiculo-mesclado", referencia: "Mc 5:19", dentro_de: "Mc 5:18" }],
  evangelhos: { capitulos: 89, versiculos: 3778 },
};

function problemasDe(f: () => unknown): string[] {
  try {
    f();
  } catch (e) {
    if (e instanceof ErroValidacao) return e.problemas;
    throw e;
  }
  return [];
}

describe("buscarArquivo: checksum antes de interpretar", () => {
  const conteudo = new TextEncoder().encode("\\v Joao.1.1\nNo princípio\n");

  it("devolve o conteúdo quando o sha256 confere e grava no destino", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ingest-"));
    try {
      const destino = path.join(dir, "n4", "joao.txt");
      const r = await buscarArquivo(
        "https://exemplo.invalido/x",
        destino,
        sha256(conteudo),
        async () => conteudo,
      );
      expect(sha256(r.conteudo)).toBe(sha256(conteudo));
      expect(existsSync(destino)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("um byte trocado lança ErroChecksum e nada é gravado", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ingest-"));
    try {
      const destino = path.join(dir, "n4", "joao.txt");
      const adulterado = conteudo.slice();
      adulterado[3] = (adulterado[3] as number) ^ 1;
      await expect(
        buscarArquivo(
          "https://exemplo.invalido/x",
          destino,
          sha256(conteudo),
          async () => adulterado,
        ),
      ).rejects.toBeInstanceOf(ErroChecksum);
      expect(existsSync(destino)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cache adulterado no disco não vale: busca de novo e confere", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ingest-"));
    try {
      const destino = path.join(dir, "joao.txt");
      await buscarArquivo("u", destino, sha256(conteudo), async () => conteudo);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(destino, "adulterado");
      let buscas = 0;
      const r = await buscarArquivo("u", destino, sha256(conteudo), async () => {
        buscas++;
        return conteudo;
      });
      expect(buscas).toBe(1);
      expect(sha256(r.conteudo)).toBe(sha256(conteudo));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("validarEdicao sobre Marcos 5 real", () => {
  const versiculos = interpretarF4(marcos5, mapa);

  it("passa com Mc 5:19 como única exceção listada (id ausente, texto dentro de 5:18)", () => {
    expect(versiculos).toHaveLength(42);
    expect(versiculos.some((v) => v.chave === 41005019)).toBe(false);
    const r = validarEdicao(versiculos, esperado, "n4", true);
    expect(r.excecoes).toBe(1);
    expect(r.versiculos).toBe(42);
  });

  it("sem a exceção listada, o buraco de Mc 5:19 reprova nomeando o versículo", () => {
    const problemas = problemasDe(() =>
      validarEdicao(versiculos, { ...esperado, excecoes: [] }, "n4", true),
    );
    expect(problemas).toEqual(["buraco: falta Marcos 5:19 (não listado nas exceções)"]);
  });

  it("outro versículo removido reprova nomeando o buraco", () => {
    const sem30 = versiculos.filter((v) => v.chave !== 41005030);
    expect(problemasDe(() => validarEdicao(sem30, esperado, "n4", true))).toEqual([
      "buraco: falta Marcos 5:30 (não listado nas exceções)",
    ]);
  });

  it("o último versículo removido reprova pela tabela de livros", () => {
    const sem43 = versiculos.filter((v) => v.chave !== 41005043);
    expect(problemasDe(() => validarEdicao(sem43, esperado, "n4", true))).toEqual([
      "Marcos 5: último versículo 42, esperava 43",
    ]);
  });

  it("id duplicado e texto vazio reprovam", () => {
    const dup: Versiculo[] = [...versiculos, versiculos[0] as Versiculo];
    expect(problemasDe(() => validarEdicao(dup, esperado, "n4", true)).join("\n")).toContain(
      "id duplicado: Marcos 5:1",
    );
    const vazio = versiculos.map((v) => (v.chave === 41005001 ? { ...v, texto: "" } : v));
    expect(problemasDe(() => validarEdicao(vazio, esperado, "n4", true)).join("\n")).toContain(
      "versículo sem texto: Marcos 5:1 (não listado em sem_texto)",
    );
  });

  it("exceção listada que não é buraco reprova", () => {
    const comOsDois = interpretarF4(
      marcos5.replace("\\v Mc.5.20", "\\v Mc.5.19\nx\n\\v Mc.5.20"),
      mapa,
    );
    expect(problemasDe(() => validarEdicao(comOsDois, esperado, "n4", true)).join("\n")).toContain(
      "exceção listada mas o versículo existe",
    );
  });

  it("texto vazio só é aceito quando nomeado para a edição", () => {
    const vazio = versiculos.map((v) => (v.chave === 41005001 ? { ...v, texto: "" } : v));
    const lista: Esperado = {
      ...esperado,
      sem_texto: [{ referencia: "Mc 5:1", edicao: "n4", motivo: "teste" }],
    };
    expect(validarEdicao(vazio, lista, "n4", true).semTexto).toEqual(["Marcos 5:1"]);
    expect(problemasDe(() => validarEdicao(vazio, lista, "tr", true)).join("\n")).toContain(
      "sem texto",
    );
  });
});

describe("validarEdicao completa", () => {
  it("um trecho não é uma Bíblia: livros, capítulos e totais faltando reprovam", () => {
    const versiculos = interpretarF4(marcos5, mapa);
    const problemas = problemasDe(() => validarEdicao(versiculos, esperado, "n4"));
    expect(problemas).toContain("livro faltando: Gênesis");
    expect(problemas).toContain("livro faltando: Apocalipse");
    expect(problemas).toContain("42 versículos, esperava 31101");
    expect(problemas.some((p) => p.startsWith("Marcos: 1 capítulos, esperava 16"))).toBe(true);
  });
});

describe("marcador desconhecido", () => {
  it("falha na interpretação, antes de qualquer validação", () => {
    expect(() => interpretarF4(marcos5.replace("\\*added", "\\*enfeite"), mapa)).toThrow(ErroF4);
    expect(() => interpretarF4(marcos5.replace("\\v Mc.5.2\n", "\\w\n\\v Mc.5.2\n"), mapa)).toThrow(
      /marcador desconhecido: \\w/,
    );
  });
});
