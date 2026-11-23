import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executarCarga } from "../../../scripts/acervo/carregar";
import { urlDoPapel } from "../../../src/db/url";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";

// O build de produção carrega texto só do que está versionado: o caminho de carga não usa rede nenhuma. Prova
// em duas metades: (1) a carga inteira roda com `fetch` e os módulos de rede do Node trocados por funções que
// lançam; (2) a análise das importações de `carregar.ts` e `derivados.ts` não alcança o módulo de download.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURES = path.join(RAIZ, "tests", "fixtures", "acervo");
const temporarios: string[] = [];
let banco: BancoDeExecucao | undefined;
let cliente: pg.Client | undefined;
let leitor: pg.Client | undefined;

beforeAll(async () => {
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  cliente = new pg.Client({
    connectionString: urlDoPapel("carga", { agrupada: false }, preparado.env),
  });
  // A conexão é aberta ANTES de a rede ser trocada: o que o teste proíbe é abrir conexão nova, e a carga não
  // precisa de nenhuma (usa o cliente já aberto, o mesmo contrato de `semearAcervo`).
  await cliente.connect();
  leitor = new pg.Client({ connectionString: preparado.banco.url });
  await leitor.connect();
}, 120_000);

afterAll(async () => {
  await cliente?.end().catch(() => {});
  await leitor?.end().catch(() => {});
  if (banco) await removerBancoDeExecucao(banco.nome);
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

function montarPastas(): { fontes: string; derivados: string; lock: string } {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-sem-rede-"));
  temporarios.push(raiz);
  const fontes = path.join(raiz, "fontes");
  const derivados = path.join(raiz, "derivados");
  mkdirSync(fontes);
  mkdirSync(derivados);
  cpSync(path.join(FIXTURES, "fontes"), fontes, { recursive: true });
  cpSync(path.join(FIXTURES, "derivados"), derivados, { recursive: true });
  const bytes = readFileSync(path.join(derivados, "josefo-antiguidades.json"));
  const lock = path.join(raiz, "lock.json");
  writeFileSync(
    lock,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {
        "josefo-antiguidades": {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
      },
    }),
  );
  return { fontes, derivados, lock };
}

function proibirRede(): () => void {
  const lanca = (nome: string) => () => {
    throw new Error(`rede proibida na carga: ${nome}`);
  };
  const espioes = [
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.reject(new Error("rede proibida na carga: fetch"))),
    vi.spyOn(http, "request").mockImplementation(lanca("http.request")),
    vi.spyOn(http, "get").mockImplementation(lanca("http.get")),
    vi.spyOn(https, "request").mockImplementation(lanca("https.request")),
    vi.spyOn(https, "get").mockImplementation(lanca("https.get")),
    vi.spyOn(net, "connect").mockImplementation(lanca("net.connect")),
    vi.spyOn(net, "createConnection").mockImplementation(lanca("net.createConnection")),
    vi.spyOn(tls, "connect").mockImplementation(lanca("tls.connect")),
  ];
  return () => {
    for (const e of espioes) e.mockRestore();
  };
}

describe("carga sem rede", () => {
  it("o controle positivo: com a rede trocada, qualquer chamada de rede lança", async () => {
    const restaurar = proibirRede();
    try {
      await expect(fetch("https://exemplo.org/")).rejects.toThrow(/rede proibida/);
      expect(() => net.connect(80, "127.0.0.1")).toThrow(/rede proibida/);
      expect(() => https.get("https://exemplo.org/")).toThrow(/rede proibida/);
    } finally {
      restaurar();
    }
  });

  it("a carga dos derivados da fixture termina sem erro com fetch, http, https e net lançando", async () => {
    const pastas = montarPastas();
    const restaurar = proibirRede();
    try {
      const r = await executarCarga(pastas, {
        abrir: async () => cliente as pg.Client,
        escrever: () => {},
      });
      expect(r.carregadas).toBe(1);
      expect(r.resultado?.paragrafos.inseridos).toBe(2);
    } finally {
      restaurar();
    }
    const lidos = await (leitor as pg.Client).query<{ n: string }>(
      "select count(*) as n from acervo.fonte_paragrafo",
    );
    expect(Number(lidos.rows[0]?.n)).toBe(2);
  });
});

// ───────────────────────── análise das importações ─────────────────────────

const EXTENSOES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolver(de: string, alvo: string): string | null {
  let base: string;
  if (alvo.startsWith("@/")) base = path.join(RAIZ, "src", alvo.slice(2));
  else if (alvo.startsWith(".")) base = path.resolve(path.dirname(de), alvo);
  else return null; // pacote ou módulo do Node: fica de fora da análise de arquivos próprios
  for (const ext of ["", ...EXTENSOES]) {
    const candidato = `${base}${ext}`;
    if (/\.(ts|tsx)$/.test(candidato) && existsSync(candidato)) return candidato;
  }
  return null;
}

/** Todos os arquivos próprios alcançáveis por `import`/`export from`/`import()` a partir da entrada. */
function alcancaveis(entrada: string): Set<string> {
  const vistos = new Set<string>();
  const fila = [entrada];
  const re =
    /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  while (fila.length > 0) {
    const atual = fila.pop() as string;
    if (vistos.has(atual)) continue;
    vistos.add(atual);
    const fonte = readFileSync(atual, "utf8");
    for (const m of fonte.matchAll(re)) {
      const alvo = m[1] ?? m[2] ?? m[3];
      const arquivo = alvo ? resolver(atual, alvo) : null;
      if (arquivo) fila.push(arquivo);
    }
  }
  return vistos;
}

describe("análise das importações", () => {
  const entradas = ["carregar.ts", "derivados.ts"].map((n) =>
    path.join(RAIZ, "scripts", "acervo", n),
  );

  it("nenhuma entrada da carga alcança um módulo de download (acervo-baixar)", () => {
    for (const entrada of entradas) {
      const alcance = alcancaveis(entrada);
      // Controle positivo: a análise anda de fato pelos módulos (não devolve só a entrada).
      expect(alcance.size).toBeGreaterThan(1);
      const baixadores = [...alcance].filter((a) => /acervo-baixar/.test(a));
      expect(baixadores, `${path.basename(entrada)} alcança ${baixadores.join(", ")}`).toEqual([]);
    }
  });

  it("o controle negativo: a análise enxerga um baixador escondido atrás de duas importações", () => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-importacoes-"));
    temporarios.push(raiz);
    writeFileSync(path.join(raiz, "acervo-baixar.ts"), "export const x = 1;\n");
    writeFileSync(
      path.join(raiz, "meio.ts"),
      'import { x } from "./acervo-baixar";\nexport const y = x;\n',
    );
    writeFileSync(
      path.join(raiz, "entrada.ts"),
      'import { y } from "./meio";\nexport const z = y;\n',
    );
    const alcance = [...alcancaveis(path.join(raiz, "entrada.ts"))];
    expect(alcance.some((a) => /acervo-baixar/.test(a))).toBe(true);
  });
});
