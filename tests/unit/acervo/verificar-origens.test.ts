import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { derivarParaDisco } from "../../../scripts/ingest/acervo-derivar";
import { verificarAcervo } from "../../../scripts/ingest/acervo-verificar";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const bruto = readFileSync(
  path.join(RAIZ, "tests", "fixtures", "acervo", "perseus-josefo-trecho.xml"),
);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const ORIGEM = (publicavel = true, secoes = 2) => ({
  nome: "Perseus (teste)",
  autores: ["Perseus"],
  licenca: "CC BY-SA",
  url_licenca: "https://creativecommons.org/licenses/by-sa/4.0/",
  fonte: "https://github.com/PerseusDL/canonical-greekLit",
  commit: "dacb04909e43dc47738828d33cc3d2b0635bc54c",
  data_versao: "2026-11-13",
  alteracoes: "Notas de editor removidas.",
  formato: "tei",
  publicavel,
  motivo: "teste",
  arquivos: [
    {
      id: "josefo.xml",
      url: "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/dacb04909e43dc47738828d33cc3d2b0635bc54c/x.xml",
      slug: "josefo-antiguidades",
      idioma: "en",
    },
  ],
  verificador: { tradutores: ["William Whiston"], licenca: "CC BY-SA" },
  esperado: {
    secoes,
    paragrafos: [{ ref: "18.63", contem: ["wise man"], ref_inicio: 63, ref_fim: 64 }],
    notas_fora_do_texto: true,
  },
});

/** Cenário com derivado já gerado. `comBruto` false simula máquina sem cache. */
function montar(comBruto = true) {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-verificar-"));
  temporarios.push(raiz);
  const opcoes = {
    origens: path.join(raiz, "origens.yaml"),
    lockBruto: path.join(raiz, "acervo.lock.json"),
    bruto: path.join(raiz, "raw"),
    derivados: path.join(raiz, "derivados"),
    lockDerivados: path.join(raiz, "derivados.lock.json"),
  };
  writeFileSync(opcoes.origens, JSON.stringify({ perseus: ORIGEM() }));
  writeFileSync(
    opcoes.lockBruto,
    JSON.stringify({ arquivos: { "perseus/josefo.xml": sha(bruto) } }),
  );
  writeFileSync(
    opcoes.lockDerivados,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {},
    }),
  );
  mkdirSync(path.join(opcoes.bruto, "perseus"), { recursive: true });
  writeFileSync(path.join(opcoes.bruto, "perseus", "josefo.xml"), bruto);
  derivarParaDisco("josefo-antiguidades", opcoes);
  if (!comBruto) rmSync(opcoes.bruto, { recursive: true, force: true });
  return { raiz, opcoes };
}

const rodar = (o: ReturnType<typeof montar>["opcoes"]) =>
  spawnSync(
    path.join(RAIZ, "node_modules", ".bin", "tsx"),
    [
      "scripts/ingest/acervo-verificar.ts",
      "--origens",
      o.origens,
      "--lock-bruto",
      o.lockBruto,
      "--bruto",
      o.bruto,
      "--derivados",
      o.derivados,
      "--lock-derivados",
      o.lockDerivados,
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

describe("acervo:verify", () => {
  it("com derivado e bruto íntegros sai 0 e confere os fatos esperados e a reprodução", () => {
    const { opcoes } = montar();
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(0);
    expect(r.linhas.join("\n")).toMatch(/OK josefo-antiguidades \(/);
    expect(r.linhas.join("\n")).toMatch(/OK perseus\/josefo\.xml \(2 seções/);
    expect(r.linhas.join("\n")).toMatch(/reproduz a partir do bruto/);
  });

  it("origem sem bruto em cache NÃO reprova e aparece como SEM BRUTO (processo de verdade, saída 0)", () => {
    const { opcoes } = montar(false);
    const p = rodar(opcoes);
    expect(p.status).toBe(0);
    expect(p.stdout).toContain("SEM BRUTO perseus");
    expect(p.stdout).toContain("OK josefo-antiguidades");
  });

  it("derivado adulterado reprova com saída 1 (processo de verdade)", () => {
    const { opcoes } = montar(false);
    const arquivo = path.join(opcoes.derivados, "josefo-antiguidades.json");
    writeFileSync(arquivo, readFileSync(arquivo, "utf8").replace("wise man", "wise MAN"));
    const p = rodar(opcoes);
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(
      /REPROVADO derivados: derivado josefo-antiguidades: tamanho|sha256 diferente/,
    );
  });

  it("derivado fora do lock reprova", () => {
    const { opcoes } = montar(false);
    writeFileSync(
      opcoes.lockDerivados,
      JSON.stringify({
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: 31_457_280,
        derivados: {},
      }),
    );
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(/fora do lock/);
  });

  it("`esperado` impossível reprova o bruto", () => {
    const { opcoes } = montar();
    writeFileSync(opcoes.origens, JSON.stringify({ perseus: ORIGEM(true, 99) }));
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(/REPROVADO perseus\/josefo\.xml: .*esperadas 99 seções/);
  });

  it("origem marcada não publicável reprova o derivado que dela veio", () => {
    const { opcoes } = montar(false);
    writeFileSync(opcoes.origens, JSON.stringify({ perseus: ORIGEM(false) }));
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(/não é publicável/);
  });

  it("bruto adulterado (sha256 diferente do lock) reprova", () => {
    const { opcoes } = montar();
    writeFileSync(path.join(opcoes.bruto, "perseus", "josefo.xml"), `${bruto.toString("utf8")} `);
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(/REPROVADO perseus\/josefo\.xml: sha256 diferente/);
  });
});

describe("acervo:verify: origem não publicável com bruto em cache", () => {
  it("aparece como NÃO PUBLICÁVEL com o motivo e o aviso editorial, e NÃO reprova (saída 0)", () => {
    const { opcoes } = montar(false);
    const tacito = readFileSync(
      path.join(RAIZ, "tests", "fixtures", "acervo", "perseus-tacito-trecho.xml"),
    );
    const arq = "phi1351.phi005.perseus-eng2.xml";
    writeFileSync(
      opcoes.origens,
      JSON.stringify({
        perseus: ORIGEM(),
        "perseus-latinlit-tacito": {
          ...ORIGEM(false, 1),
          motivo: "conferência de 1895 pendente",
          arquivos: [
            {
              id: arq,
              url: "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/dacb04909e43dc47738828d33cc3d2b0635bc54c/x.xml",
              slug: "tacito-anais",
              idioma: "en",
            },
          ],
          verificador: {
            tradutores: ["Alfred John Church", "William Jackson Brodribb"],
            licenca: "Attribution-ShareAlike 4.0",
          },
          esperado: {
            secoes: 1,
            paragrafos: [{ ref: "15.44", contem: ["Christus"] }],
            notas_fora_do_texto: true,
          },
        },
      }),
    );
    writeFileSync(
      opcoes.lockBruto,
      JSON.stringify({
        arquivos: {
          "perseus/josefo.xml": sha(bruto),
          [`perseus-latinlit-tacito/${arq}`]: sha(tacito),
        },
      }),
    );
    mkdirSync(path.join(opcoes.bruto, "perseus-latinlit-tacito"), { recursive: true });
    writeFileSync(path.join(opcoes.bruto, "perseus-latinlit-tacito", arq), tacito);
    const p = rodar(opcoes);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(
      /NÃO PUBLICÁVEL perseus-latinlit-tacito\/phi1351\.phi005\.perseus-eng2\.xml: conferência de 1895 pendente/,
    );
    expect(p.stdout).toMatch(/AVISO .*1942/);
    expect(p.stdout).not.toContain("REPROVADO");
  });

  it("controle negativo: o bruto de uma origem não publicável que não confere AINDA reprova", () => {
    const { opcoes } = montar(false);
    const tacito = readFileSync(
      path.join(RAIZ, "tests", "fixtures", "acervo", "perseus-tacito-trecho.xml"),
    );
    const arq = "phi1351.phi005.perseus-eng2.xml";
    writeFileSync(
      opcoes.origens,
      JSON.stringify({
        perseus: ORIGEM(),
        "perseus-latinlit-tacito": {
          ...ORIGEM(false, 1),
          arquivos: [
            {
              id: arq,
              url: "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/dacb04909e43dc47738828d33cc3d2b0635bc54c/x.xml",
              slug: "tacito-anais",
              idioma: "en",
            },
          ],
          verificador: { tradutores: ["William Whiston"], licenca: "Attribution-ShareAlike 4.0" },
          esperado: { secoes: 1, paragrafos: [], notas_fora_do_texto: true },
        },
      }),
    );
    writeFileSync(
      opcoes.lockBruto,
      JSON.stringify({
        arquivos: {
          "perseus/josefo.xml": sha(bruto),
          [`perseus-latinlit-tacito/${arq}`]: sha(tacito),
        },
      }),
    );
    mkdirSync(path.join(opcoes.bruto, "perseus-latinlit-tacito"), { recursive: true });
    writeFileSync(path.join(opcoes.bruto, "perseus-latinlit-tacito", arq), tacito);
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(/REPROVADO perseus-latinlit-tacito\/.*tradutor/);
  });
});

describe("acervo:verify: origem publicável com aviso editorial no cabeçalho", () => {
  it("fica OK e o aviso da edição digital é registrado, sem reprovar", () => {
    const { opcoes } = montar(false);
    const tacito = readFileSync(
      path.join(RAIZ, "tests", "fixtures", "acervo", "perseus-tacito-trecho.xml"),
    );
    const arq = "phi1351.phi005.perseus-eng2.xml";
    writeFileSync(
      opcoes.origens,
      JSON.stringify({
        perseus: ORIGEM(),
        "perseus-latinlit-tacito": {
          ...ORIGEM(true, 1),
          arquivos: [
            {
              id: arq,
              url: "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/dacb04909e43dc47738828d33cc3d2b0635bc54c/x.xml",
              slug: "tacito-anais",
              idioma: "en",
            },
          ],
          verificador: {
            tradutores: ["Alfred John Church", "William Jackson Brodribb"],
            licenca: "Attribution-ShareAlike 4.0",
          },
          esperado: { secoes: 1, paragrafos: [{ ref: "15.44", contem: ["Christus"] }] },
        },
      }),
    );
    writeFileSync(
      opcoes.lockBruto,
      JSON.stringify({
        arquivos: {
          "perseus/josefo.xml": sha(bruto),
          [`perseus-latinlit-tacito/${arq}`]: sha(tacito),
        },
      }),
    );
    mkdirSync(path.join(opcoes.bruto, "perseus-latinlit-tacito"), { recursive: true });
    writeFileSync(path.join(opcoes.bruto, "perseus-latinlit-tacito", arq), tacito);
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(0);
    const saida = r.linhas.join("\n");
    expect(saida).toMatch(/AVISO perseus-latinlit-tacito\/.*1942/);
    expect(saida).toMatch(
      /OK perseus-latinlit-tacito\/phi1351\.phi005\.perseus-eng2\.xml \(1 seções/,
    );
    expect(saida).not.toContain("NÃO PUBLICÁVEL");
  });
});

// ───────────────────────── plano 02-27: Gutenberg pelo espelho ─────────────────────────
const FIXTURES_ACERVO = path.join(RAIZ, "tests", "fixtures", "acervo");
const DECLARACAO_PG =
  "Creating the works from public domain print editions means that no one owns a United States copyright in these works";
const ROMANOS: string[] = [];
for (let n = 1; n <= 200; n++) {
  let resto = n;
  let s = "";
  for (const [letras, valor] of [
    ["C", 100],
    ["XC", 90],
    ["L", 50],
    ["XL", 40],
    ["X", 10],
    ["IX", 9],
    ["V", 5],
    ["IV", 4],
    ["I", 1],
  ] as const)
    while (resto >= valor) {
      s += letras;
      resto -= valor;
    }
  ROMANOS.push(s);
}

type Opcoes = ReturnType<typeof montar>["opcoes"];

/** Cenário vazio (sem o Josefo), só com a origem dada em cache e no lock do bruto. */
function cenario(
  origemId: string,
  o: Record<string, unknown>,
  arquivoId: string,
  bruto: Buffer,
): Opcoes {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-verificar-27-"));
  temporarios.push(raiz);
  const opcoes: Opcoes = {
    origens: path.join(raiz, "origens.yaml"),
    lockBruto: path.join(raiz, "acervo.lock.json"),
    bruto: path.join(raiz, "raw"),
    derivados: path.join(raiz, "derivados"),
    lockDerivados: path.join(raiz, "derivados.lock.json"),
  };
  writeFileSync(opcoes.origens, JSON.stringify({ [origemId]: o }));
  writeFileSync(
    opcoes.lockBruto,
    JSON.stringify({ arquivos: { [`${origemId}/${arquivoId}`]: sha(bruto) } }),
  );
  writeFileSync(
    opcoes.lockDerivados,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {},
    }),
  );
  mkdirSync(path.join(opcoes.bruto, origemId), { recursive: true });
  writeFileSync(path.join(opcoes.bruto, origemId, arquivoId), bruto);
  return opcoes;
}

const gutenberg = (
  origem: Record<string, unknown>,
  arquivo: Record<string, unknown>,
  esperado: Record<string, unknown>,
) => ({ ...ORIGEM(true), ...origem, formato: "gutenberg", arquivos: [arquivo], esperado });

describe("acervo:verify: origem barrada porque o arquivo não prova a licença (Suetônio #6400)", () => {
  const bordas = readFileSync(path.join(FIXTURES_ACERVO, "gutenberg-suetonio-bordas.txt"));
  const ARQ = "6400-0.txt";
  const SUETONIO = {
    nome: "Project Gutenberg eBook #6400 (teste)",
    commit: "0".repeat(64),
    publicavel: false,
    motivo: "licença não provada na origem",
    verificador: { tradutores: ["Alexander Thomson", "T.Forester"], licenca: DECLARACAO_PG },
  };
  const ARQUIVO = {
    id: ARQ,
    url: "https://gutenberg.pglaf.org/6/4/0/6400/6400-0.txt",
    slug: "suetonio-doze-cesares",
    idioma: "en",
    estrutura: "cartas",
    secoes: ["x"],
  };

  it("aparece como NÃO PUBLICÁVEL com o motivo e NÃO reprova (processo de verdade, saída 0)", () => {
    const opcoes = cenario(
      "gutenberg-suetonio-6400",
      gutenberg(SUETONIO, ARQUIVO, { secoes: 1 }),
      ARQ,
      bordas,
    );
    const p = rodar(opcoes);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(
      /NÃO PUBLICÁVEL gutenberg-suetonio-6400\/6400-0\.txt: licença não provada na origem/,
    );
    expect(p.stdout).toMatch(/sha256 do bruto confere/);
    expect(p.stdout).toMatch(/licença não provada na origem: nenhuma das bordas/);
    expect(p.stdout).not.toContain("REPROVADO");
  });

  it("controle negativo: a MESMA origem marcada publicável reprova (saída 1): a licença continua sem prova", () => {
    const opcoes = cenario(
      "gutenberg-suetonio-6400",
      gutenberg({ ...SUETONIO, publicavel: true, motivo: "alguém trocou a bandeira" }, ARQUIVO, {
        secoes: 1,
      }),
      ARQ,
      bordas,
    );
    const p = rodar(opcoes);
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(
      /REPROVADO gutenberg-suetonio-6400\/6400-0\.txt: .*licença não provada na origem/,
    );
    expect(p.stdout).not.toContain("NÃO PUBLICÁVEL");
  });

  it("controle negativo: bruto adulterado reprova pelo sha256, mesmo com a origem barrada", () => {
    const opcoes = cenario(
      "gutenberg-suetonio-6400",
      gutenberg(SUETONIO, ARQUIVO, { secoes: 1 }),
      ARQ,
      bordas,
    );
    writeFileSync(
      path.join(opcoes.bruto, "gutenberg-suetonio-6400", ARQ),
      `${bordas.toString("utf8")} `,
    );
    const p = rodar(opcoes);
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(/REPROVADO gutenberg-suetonio-6400\/6400-0\.txt: sha256 diferente/);
  });
});

describe("acervo:verify: origem do Gutenberg publicável (Plínio #2811)", () => {
  const plinio = readFileSync(path.join(FIXTURES_ACERVO, "gutenberg-plinio-trecho.txt"));
  const ARQ = "2811-8.txt";
  const PLINIO = {
    nome: "Project Gutenberg eBook #2811 (teste)",
    commit: "0".repeat(64),
    publicavel: true,
    motivo: "declaração do Project Gutenberg lida na cauda do arquivo",
    verificador: { tradutores: ["William Melmoth", "F. C. T. Bosanquet"], licenca: DECLARACAO_PG },
    correspondencia_refs: { "trajano.XCVII": "10.96", "trajano.XCVIII": "10.97" },
  };
  const ARQUIVO = {
    id: ARQ,
    url: "https://gutenberg.pglaf.org/2/8/1/2811/2811-8.txt",
    slug: "plinio-cartas",
    idioma: "en",
    charset: "iso-8859-1",
    estrutura: "cartas",
    secoes: ["trajano"],
  };
  const ESPERADO = {
    secoes: 1,
    paragrafos: [
      { ref: "10.96", contem: ["Christians"], nao_contem: ["[1066]", "Project Gutenberg"] },
      { ref: "10.97", contem: ["Christians"] },
    ],
    // o recorte da fixture tirou as cartas II a XCVI
    ausentes: ROMANOS.slice(1, 96).map((n) => `trajano.${n}`),
  };

  it("fica OK, sem reprovar, e registra a lacuna declarada e as cartas fora da tabela", () => {
    const opcoes = cenario(
      "gutenberg-plinio-2811",
      gutenberg(PLINIO, ARQUIVO, ESPERADO),
      ARQ,
      plinio,
    );
    const p = rodar(opcoes);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(
      /OK gutenberg-plinio-2811\/2811-8\.txt \(1 seções, 3 parágrafos, notas fora\)/,
    );
    expect(p.stdout).toMatch(
      /AVISO gutenberg-plinio-2811\/2811-8\.txt: o arquivo de origem não traz 95 unidade\(s\)/,
    );
    expect(p.stdout).toMatch(/trajano\.II/);
    expect(p.stdout).toMatch(
      /NUMERAÇÃO gutenberg-plinio-2811\/2811-8\.txt: 1 unidade\(s\) fora da tabela de correspondência/,
    );
    expect(p.stdout).not.toContain("REPROVADO");
    expect(p.stdout).not.toContain("NÃO PUBLICÁVEL");
  });

  it("lacuna que o registro não declara reprova o bruto", () => {
    const opcoes = cenario(
      "gutenberg-plinio-2811",
      gutenberg(PLINIO, ARQUIVO, { ...ESPERADO, ausentes: [] }),
      ARQ,
      plinio,
    );
    const p = rodar(opcoes);
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(/REPROVADO gutenberg-plinio-2811\/2811-8\.txt: .*ausentes no arquivo/);
  });
});
