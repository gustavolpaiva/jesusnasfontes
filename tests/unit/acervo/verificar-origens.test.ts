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
