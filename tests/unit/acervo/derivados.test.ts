import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { executarCarga } from "../../../scripts/acervo/carregar";
import {
  ErroDerivado,
  lerDerivado,
  lerLock,
  verificarDerivados,
} from "../../../scripts/acervo/derivados";

// A carga só aceita derivado conferido contra o lock (sha256 e bytes) e contra o orçamento, e confere ANTES de
// abrir qualquer conexão. Tudo aqui roda sobre pastas e locks sintéticos em diretório temporário.

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ORCAMENTO = { orcamento_arquivo_bytes: 8_388_608, orcamento_total_bytes: 31_457_280 };

type Lock = {
  orcamento_arquivo_bytes: number;
  orcamento_total_bytes: number;
  derivados: Record<string, { sha256: string; bytes: number }>;
};

/** Pasta de derivados com o JSON do Josefo e o lock que a descreve (ajustável pelo teste). */
function montar(ajustar?: (lock: Lock, pasta: string) => void): {
  pasta: string;
  lock: Lock;
  arquivoDoLock: string;
  fontes: string;
  raiz: string;
} {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-derivados-"));
  temporarios.push(raiz);
  const pasta = path.join(raiz, "derivados");
  const fontes = path.join(raiz, "fontes");
  mkdirSync(pasta);
  mkdirSync(fontes);
  cpSync(
    path.join(FIXTURES, "derivados", "josefo-antiguidades.json"),
    path.join(pasta, "josefo-antiguidades.json"),
  );
  cpSync(
    path.join(FIXTURES, "fontes", "josefo-antiguidades.yaml"),
    path.join(fontes, "josefo-antiguidades.yaml"),
  );
  const bytes = readFileSync(path.join(pasta, "josefo-antiguidades.json"));
  const lock: Lock = {
    ...ORCAMENTO,
    derivados: { "josefo-antiguidades": { sha256: sha(bytes), bytes: bytes.length } },
  };
  ajustar?.(lock, pasta);
  const arquivoDoLock = path.join(raiz, "lock.json");
  writeFileSync(arquivoDoLock, JSON.stringify(lock, null, 2));
  return { pasta, lock, arquivoDoLock, fontes, raiz };
}

function mensagemDe(f: () => unknown): string {
  try {
    f();
  } catch (erro) {
    expect(erro).toBeInstanceOf(ErroDerivado);
    return (erro as Error).message;
  }
  throw new Error("esperava ErroDerivado, mas nada foi lançado");
}

describe("verificarDerivados", () => {
  it("devolve os derivados conferidos quando tudo bate com o lock", () => {
    const { pasta, lock } = montar();
    const lista = verificarDerivados(pasta, lock);
    expect(lista.map((d) => d.slug)).toEqual(["josefo-antiguidades"]);
    expect(lista[0]?.bytes).toBe(lock.derivados["josefo-antiguidades"]?.bytes);
  });

  it("pasta ausente com lock vazio é válida e devolve lista vazia", () => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-derivados-"));
    temporarios.push(raiz);
    const lock: Lock = { ...ORCAMENTO, derivados: {} };
    expect(verificarDerivados(path.join(raiz, "nao-existe"), lock)).toEqual([]);
  });

  it("um byte adulterado (mesmo tamanho) falha pelo sha256, nomeando a Fonte", () => {
    const { pasta, lock } = montar();
    const arquivo = path.join(pasta, "josefo-antiguidades.json");
    const bytes = readFileSync(arquivo);
    const i = bytes.indexOf("wise man");
    bytes[i] = "W".charCodeAt(0);
    writeFileSync(arquivo, bytes);
    const msg = mensagemDe(() => verificarDerivados(pasta, lock));
    expect(msg).toContain("josefo-antiguidades");
    expect(msg).toContain("sha256");
    expect(msg).not.toContain("wise man");
  });

  it("arquivo fora do lock falha nomeando a Fonte", () => {
    const { pasta, lock } = montar();
    writeFileSync(path.join(pasta, "intruso.json"), "{}");
    expect(mensagemDe(() => verificarDerivados(pasta, lock))).toContain("intruso");
  });

  it("entrada do lock sem arquivo falha nomeando a Fonte", () => {
    const { pasta, lock } = montar((l) => {
      l.derivados.fantasma = { sha256: "a".repeat(64), bytes: 10 };
    });
    expect(mensagemDe(() => verificarDerivados(pasta, lock))).toContain("fantasma");
  });

  it("tamanho diferente do lock falha, com o valor do lock e o medido", () => {
    const { pasta, lock } = montar((l) => {
      const e = l.derivados["josefo-antiguidades"];
      if (e) e.bytes += 1;
    });
    const msg = mensagemDe(() => verificarDerivados(pasta, lock));
    expect(msg).toContain("josefo-antiguidades");
    expect(msg).toContain("tamanho");
    expect(msg).toMatch(/\d+ bytes/);
  });

  it("derivado acima do orçamento por arquivo falha, nomeando o limite e o valor medido", () => {
    const { pasta, lock } = montar((l) => {
      l.orcamento_arquivo_bytes = 100;
    });
    const msg = mensagemDe(() => verificarDerivados(pasta, lock));
    expect(msg).toContain("orcamento_arquivo_bytes");
    expect(msg).toContain("100");
    expect(msg).toContain(String(lock.derivados["josefo-antiguidades"]?.bytes));
  });

  it("derivado exatamente no limite passa (o limite é inclusivo)", () => {
    const { pasta, lock } = montar((l, p) => {
      l.orcamento_arquivo_bytes = readFileSync(path.join(p, "josefo-antiguidades.json")).length;
    });
    expect(verificarDerivados(pasta, lock)).toHaveLength(1);
  });

  it("soma acima do orçamento total falha, nomeando o limite e a soma medida", () => {
    const { pasta, lock } = montar((l, p) => {
      const original = readFileSync(path.join(p, "josefo-antiguidades.json"));
      writeFileSync(path.join(p, "outra-fonte.json"), original);
      l.derivados["outra-fonte"] = { sha256: sha(original), bytes: original.length };
      l.orcamento_total_bytes = original.length + 10;
    });
    const msg = mensagemDe(() => verificarDerivados(pasta, lock));
    expect(msg).toContain("orcamento_total_bytes");
    expect(msg).toContain(String((lock.derivados["josefo-antiguidades"]?.bytes ?? 0) * 2));
  });
});

describe("lerLock", () => {
  it("lê o lock do produto (nasce vazio, com os dois orçamentos gravados)", async () => {
    const real = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "data",
      "acervo-derivados.lock.json",
    );
    const lock = lerLock(real);
    expect(lock.orcamento_arquivo_bytes).toBe(8_388_608);
    expect(lock.orcamento_total_bytes).toBe(31_457_280);
    expect(lock.derivados).toBeTypeOf("object");
  });

  it("lock ausente, ilegível ou fora do formato falha com ErroDerivado", () => {
    const { raiz } = montar();
    expect(() => lerLock(path.join(raiz, "nao-existe.json"))).toThrow(ErroDerivado);
    writeFileSync(path.join(raiz, "ruim.json"), "{");
    expect(() => lerLock(path.join(raiz, "ruim.json"))).toThrow(ErroDerivado);
    writeFileSync(path.join(raiz, "sem-orcamento.json"), JSON.stringify({ derivados: {} }));
    expect(mensagemDe(() => lerLock(path.join(raiz, "sem-orcamento.json")))).toContain("orcamento");
  });
});

describe("lerDerivado", () => {
  it("confere o hash dos bytes que vai interpretar e devolve o contrato", () => {
    const { pasta, lock } = montar();
    const d = lerDerivado(pasta, lock, "josefo-antiguidades");
    expect(d.secoes).toHaveLength(2);
  });

  it("recusa arquivo trocado depois da conferência (nada é interpretado)", () => {
    const { pasta, lock } = montar();
    verificarDerivados(pasta, lock);
    writeFileSync(path.join(pasta, "josefo-antiguidades.json"), "{}");
    expect(() => lerDerivado(pasta, lock, "josefo-antiguidades")).toThrow(ErroDerivado);
  });
});

describe("executarCarga: confere tudo ANTES de abrir qualquer conexão", () => {
  const casos: [string, (lock: Lock, pasta: string) => void][] = [
    [
      "adulteração",
      (_l, p) => {
        const arquivo = path.join(p, "josefo-antiguidades.json");
        const b = readFileSync(arquivo);
        b[b.indexOf("wise man")] = "W".charCodeAt(0);
        writeFileSync(arquivo, b);
      },
    ],
    ["arquivo fora do lock", (_l, p) => writeFileSync(path.join(p, "intruso.json"), "{}")],
    [
      "tamanho diferente",
      (l) => {
        const e = l.derivados["josefo-antiguidades"];
        if (e) e.bytes += 1;
      },
    ],
    [
      "orçamento por arquivo",
      (l) => {
        l.orcamento_arquivo_bytes = 100;
      },
    ],
    [
      "orçamento total",
      (l) => {
        l.orcamento_total_bytes = 100;
      },
    ],
  ];

  for (const [nome, ajustar] of casos) {
    it(`recusa por ${nome} sem criar o cliente do banco`, async () => {
      const m = montar(ajustar);
      const abrir = vi.fn(async () => {
        throw new Error("o cliente do banco não podia ser criado");
      });
      await expect(
        executarCarga(
          { fontes: m.fontes, derivados: m.pasta, lock: m.arquivoDoLock },
          { abrir, escrever: () => {} },
        ),
      ).rejects.toThrow(ErroDerivado);
      expect(abrir).not.toHaveBeenCalled();
    });
  }

  it("contrato inválido de YAML ou de derivado também falha antes da conexão", async () => {
    const m = montar();
    writeFileSync(path.join(m.fontes, "josefo-antiguidades.yaml"), "slug: Errado_Slug\n");
    const abrir = vi.fn();
    await expect(
      executarCarga(
        { fontes: m.fontes, derivados: m.pasta, lock: m.arquivoDoLock },
        { abrir, escrever: () => {} },
      ),
    ).rejects.toThrow(/slug/);
    expect(abrir).not.toHaveBeenCalled();
  });

  it("Fonte publicada sem derivado é erro; Fonte não publicada sem derivado é pulada e listada", async () => {
    const m = montar((l) => {
      l.derivados = {};
    });
    rmSync(path.join(m.pasta, "josefo-antiguidades.json"));
    const abrir = vi.fn();
    await expect(
      executarCarga(
        { fontes: m.fontes, derivados: m.pasta, lock: m.arquivoDoLock },
        { abrir, escrever: () => {} },
      ),
    ).rejects.toThrow(/publicada.*sem derivado|sem derivado.*publicada/);

    const yaml = readFileSync(path.join(m.fontes, "josefo-antiguidades.yaml"), "utf8").replace(
      "publicada: true",
      "publicada: false",
    );
    writeFileSync(path.join(m.fontes, "josefo-antiguidades.yaml"), yaml);
    const saida: string[] = [];
    const r = await executarCarga(
      { fontes: m.fontes, derivados: m.pasta, lock: m.arquivoDoLock },
      { abrir, escrever: (t) => saida.push(t) },
    );
    expect(r.carregadas).toBe(0);
    expect(r.puladas).toEqual(["josefo-antiguidades"]);
    expect(saida.join("\n")).toContain("josefo-antiguidades");
    expect(abrir).not.toHaveBeenCalled();
  });

  it("lock vazio e nenhum derivado: sai bem, diz que não há o que carregar e não abre conexão", async () => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-vazio-"));
    temporarios.push(raiz);
    const lock = path.join(raiz, "lock.json");
    writeFileSync(lock, JSON.stringify({ ...ORCAMENTO, derivados: {} }));
    const saida: string[] = [];
    const abrir = vi.fn();
    const r = await executarCarga(
      { fontes: path.join(raiz, "fontes"), derivados: path.join(raiz, "derivados"), lock },
      { abrir, escrever: (t) => saida.push(t) },
    );
    expect(r.carregadas).toBe(0);
    expect(saida.join("\n")).toContain("não há derivado a carregar");
    expect(abrir).not.toHaveBeenCalled();
  });
});

describe("comando acervo:load (processo de verdade)", () => {
  const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  // Sem nenhuma variável do banco: se o comando tentasse conectar, o erro seria outro, e o teste acusa.
  const rodar = (m: { fontes: string; pasta: string; arquivoDoLock: string }) =>
    spawnSync(
      path.join(RAIZ, "node_modules", ".bin", "tsx"),
      [
        "scripts/acervo/carregar.ts",
        "--fontes",
        m.fontes,
        "--derivados",
        m.pasta,
        "--lock",
        m.arquivoDoLock,
      ],
      {
        cwd: RAIZ,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        } as unknown as NodeJS.ProcessEnv,
      },
    );

  it("sai 1 com derivado adulterado, e a mensagem nomeia a Fonte sem trazer o texto", () => {
    const m = montar((_l, p) => {
      const arquivo = path.join(p, "josefo-antiguidades.json");
      const b = readFileSync(arquivo);
      b[b.indexOf("wise man")] = "W".charCodeAt(0);
      writeFileSync(arquivo, b);
    });
    const r = rodar(m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("josefo-antiguidades");
    expect(r.stderr).toContain("sha256");
    expect(r.stderr + r.stdout).not.toContain("wise man");
  });

  it("sai 0 com o lock vazio e nenhum derivado", () => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-vazio-cli-"));
    temporarios.push(raiz);
    const arquivoDoLock = path.join(raiz, "lock.json");
    writeFileSync(arquivoDoLock, JSON.stringify({ ...ORCAMENTO, derivados: {} }));
    const r = rodar({
      fontes: path.join(raiz, "fontes"),
      pasta: path.join(raiz, "derivados"),
      arquivoDoLock,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("não há derivado a carregar");
  });
});
