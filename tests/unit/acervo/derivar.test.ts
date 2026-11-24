import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ErroChecksum } from "../../../scripts/ingest/acervo-baixar";
import {
  conferirEsperado,
  derivar,
  derivarParaDisco,
  serializar,
} from "../../../scripts/ingest/acervo-derivar";
import { ErroLicenca } from "../../../scripts/ingest/acervo-licenca";
import type { OrigemAcervo } from "../../../scripts/ingest/acervo-origens";
import { parsearTei } from "../../../scripts/ingest/acervo-parse-tei";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const bruto = new Uint8Array(readFileSync(path.join(FIXTURES, "perseus-josefo-trecho.xml")));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const SHA_BRUTO = sha(bruto);
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const origem = (mudar: Partial<OrigemAcervo> = {}): OrigemAcervo => ({
  nome: "Perseus (teste)",
  autores: ["Perseus"],
  licenca: "CC BY-SA",
  url_licenca: "https://creativecommons.org/licenses/by-sa/4.0/",
  fonte: "https://github.com/PerseusDL/canonical-greekLit",
  commit: "dacb04909e43dc47738828d33cc3d2b0635bc54c",
  data_versao: "2026-11-23",
  alteracoes: "Notas de editor removidas.",
  formato: "tei",
  publicavel: true,
  motivo: "domínio público (Whiston), edição digital CC BY-SA",
  arquivos: [
    {
      id: "tlg0526.tlg001.perseus-eng2.xml",
      url: "https://raw.githubusercontent.com/PerseusDL/canonical-greekLit/dacb04909e43dc47738828d33cc3d2b0635bc54c/x.xml",
      slug: "josefo-antiguidades",
      idioma: "en",
    },
  ],
  verificador: { tradutores: ["William Whiston"], licenca: "CC BY-SA" },
  esperado: {
    secoes: 2,
    paragrafos: [
      { ref: "18.63", contem: ["wise man"], nao_contem: [], ref_inicio: 63, ref_fim: 64 },
      {
        ref: "20.197",
        contem: ["brother of Jesus"],
        nao_contem: ["Reland"],
        ref_inicio: 197,
        ref_fim: 203,
      },
    ],
    notas_fora_do_texto: true,
  },
  ...mudar,
});

const entrada = (o = origem(), extra: Record<string, unknown> = {}) => ({
  origemId: "perseus-greeklit-josefo",
  origem: o,
  arquivo: o.arquivos[0] as OrigemAcervo["arquivos"][number],
  bruto,
  sha256Lock: SHA_BRUTO,
  rotuloLivro: "Book",
  ...extra,
});

describe("derivar", () => {
  it("do XML do trecho ao derivado: mesmos parágrafos 18.63 e 20.197 da fixture derivada do plano 01", () => {
    const d = derivar(entrada());
    const fixture = JSON.parse(
      readFileSync(path.join(FIXTURES, "derivados", "josefo-antiguidades.json"), "utf8"),
    );
    expect(d.slug).toBe("josefo-antiguidades");
    expect(d.origem_sha256).toBe(SHA_BRUTO);
    expect(d.secoes.map((s) => s.slug)).toEqual(
      fixture.secoes.map((s: { slug: string }) => s.slug),
    );
    const doDerivado = d.secoes.flatMap((s) => s.paragrafos);
    for (const s of fixture.secoes)
      for (const p of s.paragrafos) expect(doDerivado.find((x) => x.ref === p.ref)).toEqual(p);
  });

  it("é determinístico: duas derivações dão os mesmos bytes, sem data nem identificador variável", () => {
    const a = serializar(derivar(entrada()));
    const b = serializar(derivar(entrada()));
    expect(a).toBe(b);
    expect(a.endsWith("}\n")).toBe(true);
    expect(a).not.toMatch(/20\d\d-\d\d-\d\dT/);
  });

  it("origem publicavel falso é recusada", () => {
    expect(() =>
      derivar(entrada(origem({ publicavel: false, motivo: "sem licença provada" }))),
    ).toThrow(/não é publicável/);
  });

  it("sem sha256 no lock, ou com sha256 diferente, recusa antes de interpretar", () => {
    expect(() => derivar(entrada(origem(), { sha256Lock: undefined }))).toThrow(
      /sem sha256 no lock/,
    );
    expect(() => derivar(entrada(origem(), { sha256Lock: "0".repeat(64) }))).toThrow(ErroChecksum);
  });

  it("controle negativo da licença: tradutor esperado errado derruba a derivação", () => {
    const o = origem({
      verificador: { tradutores: ["Austin Morris Harmon"], licenca: "CC BY-SA" },
    });
    expect(() => derivar(entrada(o))).toThrow(ErroLicenca);
  });

  it("fato esperado impossível derruba a derivação", () => {
    const o = origem();
    o.esperado = {
      ...o.esperado,
      paragrafos: [{ ref: "18.63", contem: ["texto que não existe"], nao_contem: [] }],
    };
    expect(() => derivar(entrada(o))).toThrow(/não confere com o esperado/);
  });
});

describe("conferirEsperado", () => {
  it("acusa texto de nota dentro de parágrafo", () => {
    const tei = parsearTei(Buffer.from(bruto).toString("utf8"));
    const nota = tei.notas.find((n) => n.length >= 40) as string;
    const adulterado = structuredClone(tei);
    (adulterado.secoes[0]?.paragrafos[0] as { texto: string }).texto += ` ${nota}`;
    expect(conferirEsperado(tei, origem().esperado)).toEqual([]);
    expect(conferirEsperado(adulterado, origem().esperado).join(" ")).toMatch(/nota de editor/);
  });
});

describe("derivarParaDisco", () => {
  function montar(orcamentoArquivo = 8_388_608) {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-derivar-"));
    temporarios.push(raiz);
    const pastaBruto = path.join(raiz, "raw");
    mkdirSync(path.join(pastaBruto, "perseus-greeklit-josefo"), { recursive: true });
    writeFileSync(
      path.join(pastaBruto, "perseus-greeklit-josefo", "tlg0526.tlg001.perseus-eng2.xml"),
      bruto,
    );
    const o = origem();
    const yaml = path.join(raiz, "origens.yaml");
    // YAML escrito na forma de fluxo JSON (JSON é YAML válido): o registro real é lido pelo mesmo leitor.
    writeFileSync(yaml, JSON.stringify({ "perseus-greeklit-josefo": o }));
    const lockBruto = path.join(raiz, "acervo.lock.json");
    writeFileSync(
      lockBruto,
      JSON.stringify({
        arquivos: { "perseus-greeklit-josefo/tlg0526.tlg001.perseus-eng2.xml": SHA_BRUTO },
      }),
    );
    const lockDerivados = path.join(raiz, "derivados.lock.json");
    writeFileSync(
      lockDerivados,
      JSON.stringify({
        orcamento_arquivo_bytes: orcamentoArquivo,
        orcamento_total_bytes: 31_457_280,
        derivados: {},
      }),
    );
    const derivados = path.join(raiz, "derivados");
    return {
      raiz,
      opcoes: { origens: yaml, lockBruto, bruto: pastaBruto, derivados, lockDerivados },
    };
  }

  it("grava o derivado e o lock com bytes e sha256 medidos; a segunda derivação não muda um byte", () => {
    const { opcoes } = montar();
    const r = derivarParaDisco("josefo-antiguidades", opcoes);
    const arquivo = path.join(opcoes.derivados, "josefo-antiguidades.json");
    const lido = readFileSync(arquivo);
    expect(lido.length).toBe(r.bytes);
    expect(sha(lido)).toBe(r.sha256);
    const lock = JSON.parse(readFileSync(opcoes.lockDerivados, "utf8"));
    expect(lock.derivados["josefo-antiguidades"]).toEqual({ sha256: r.sha256, bytes: r.bytes });
    const lockAntes = readFileSync(opcoes.lockDerivados, "utf8");
    derivarParaDisco("josefo-antiguidades", opcoes);
    expect(readFileSync(arquivo).equals(lido)).toBe(true);
    expect(readFileSync(opcoes.lockDerivados, "utf8")).toBe(lockAntes);
  });

  it("estourar o orçamento por arquivo falha antes de gravar o derivado e o lock", () => {
    const { opcoes } = montar(1000);
    expect(() => derivarParaDisco("josefo-antiguidades", opcoes)).toThrow(
      /orcamento_arquivo_bytes/,
    );
    expect(existsSync(path.join(opcoes.derivados, "josefo-antiguidades.json"))).toBe(false);
    expect(JSON.parse(readFileSync(opcoes.lockDerivados, "utf8")).derivados).toEqual({});
  });

  it("bruto adulterado depois de fixado é recusado sem escrever nada", () => {
    const { opcoes } = montar();
    writeFileSync(
      path.join(opcoes.bruto, "perseus-greeklit-josefo", "tlg0526.tlg001.perseus-eng2.xml"),
      `${Buffer.from(bruto).toString("utf8")} `,
    );
    expect(() => derivarParaDisco("josefo-antiguidades", opcoes)).toThrow(ErroChecksum);
    expect(existsSync(path.join(opcoes.derivados, "josefo-antiguidades.json"))).toBe(false);
  });

  it("slug fora do registro e bruto ausente falham com mensagem clara", () => {
    const { opcoes } = montar();
    expect(() => derivarParaDisco("outra-coisa", opcoes)).toThrow(/nenhuma origem/);
    rmSync(opcoes.bruto, { recursive: true, force: true });
    expect(() => derivarParaDisco("josefo-antiguidades", opcoes)).toThrow(/bruto ausente/);
  });
});
