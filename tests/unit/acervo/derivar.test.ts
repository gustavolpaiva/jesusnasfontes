import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { YAML_NAO_TRAVADO } from "../../../scripts/acervo/entrada";
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
    expect(lock.derivados["josefo-antiguidades"]).toEqual({
      sha256: r.sha256,
      bytes: r.bytes,
      yaml_sha256: YAML_NAO_TRAVADO,
      revisao: 1,
    });
    const lockAntes = readFileSync(opcoes.lockDerivados, "utf8");
    derivarParaDisco("josefo-antiguidades", opcoes);
    expect(readFileSync(arquivo).equals(lido)).toBe(true);
    expect(readFileSync(opcoes.lockDerivados, "utf8")).toBe(lockAntes);
  });

  it("a revisão do derivado no lock é monótona: sobe quando o arquivo muda, fica quando é o mesmo", () => {
    const { opcoes } = montar();
    const r1 = derivarParaDisco("josefo-antiguidades", opcoes);
    expect(r1.revisao).toBe(1);
    // O lock passa a dizer que o derivado anterior era OUTRO (sha256 diferente), na revisão 4: derivar de novo sobe a 5.
    const lock = JSON.parse(readFileSync(opcoes.lockDerivados, "utf8"));
    lock.derivados["josefo-antiguidades"] = {
      sha256: "0".repeat(64),
      bytes: 1,
      yaml_sha256: "a".repeat(64),
      revisao: 4,
    };
    writeFileSync(opcoes.lockDerivados, JSON.stringify(lock));
    const r2 = derivarParaDisco("josefo-antiguidades", opcoes);
    expect(r2.revisao).toBe(5);
    expect(
      JSON.parse(readFileSync(opcoes.lockDerivados, "utf8")).derivados["josefo-antiguidades"],
    ).toEqual({
      sha256: r1.sha256,
      bytes: r1.bytes,
      yaml_sha256: "a".repeat(64),
      revisao: 5,
    });
    // Mesmo conteúdo outra vez: a revisão não sobe.
    expect(derivarParaDisco("josefo-antiguidades", opcoes).revisao).toBe(5);
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

describe("derivarParaDisco: Tácito com publicavel falso (D-18b)", () => {
  const brutoTacito = readFileSync(path.join(FIXTURES, "perseus-tacito-trecho.xml"));
  const ARQ = "phi1351.phi005.perseus-eng2.xml";

  function montarTacito(publicavel: boolean) {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-tacito-"));
    temporarios.push(raiz);
    const o = origem({
      nome: "Perseus (Tácito, teste)",
      fonte: "https://github.com/PerseusDL/canonical-latinLit",
      commit: "8cef51623130f2412da410858e32c322eb796c0a",
      publicavel,
      motivo: "conferência de 1895 pendente",
      arquivos: [
        {
          id: ARQ,
          url: `https://raw.githubusercontent.com/PerseusDL/canonical-latinLit/8cef51623130f2412da410858e32c322eb796c0a/x.xml`,
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
        paragrafos: [{ ref: "15.44", contem: ["Christus", "Pontius Pilatus"], nao_contem: [] }],
        notas_fora_do_texto: true,
      },
    });
    const pastaBruto = path.join(raiz, "raw");
    mkdirSync(path.join(pastaBruto, "perseus-latinlit-tacito"), { recursive: true });
    writeFileSync(path.join(pastaBruto, "perseus-latinlit-tacito", ARQ), brutoTacito);
    const origens = path.join(raiz, "origens.yaml");
    writeFileSync(origens, JSON.stringify({ "perseus-latinlit-tacito": o }));
    const lockBruto = path.join(raiz, "acervo.lock.json");
    writeFileSync(
      lockBruto,
      JSON.stringify({ arquivos: { [`perseus-latinlit-tacito/${ARQ}`]: sha(brutoTacito) } }),
    );
    const lockDerivados = path.join(raiz, "derivados.lock.json");
    writeFileSync(
      lockDerivados,
      JSON.stringify({
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: 31_457_280,
        derivados: {},
      }),
    );
    return {
      origens,
      lockBruto,
      bruto: pastaBruto,
      derivados: path.join(raiz, "derivados"),
      lockDerivados,
    };
  }

  it("com publicavel falso o derivador recusa e não escreve arquivo nem lock", () => {
    const opcoes = montarTacito(false);
    expect(() => derivarParaDisco("tacito-anais", opcoes)).toThrow(/não é publicável/);
    expect(existsSync(path.join(opcoes.derivados, "tacito-anais.json"))).toBe(false);
    expect(JSON.parse(readFileSync(opcoes.lockDerivados, "utf8")).derivados).toEqual({});
  });

  it("controle positivo: com publicavel verdadeiro a mesma origem deriva o capítulo 15.44", () => {
    const opcoes = montarTacito(true);
    derivarParaDisco("tacito-anais", opcoes);
    const d = JSON.parse(readFileSync(path.join(opcoes.derivados, "tacito-anais.json"), "utf8"));
    expect(d.secoes[0].paragrafos.map((p: { ref: string }) => p.ref)).toContain("15.44");
  });
});

describe("derivar: `esperado` por arquivo vale mais que o da origem", () => {
  it("o esperado do arquivo substitui o da origem (a Guerra tem 7 livros, as Antiguidades 20)", () => {
    const o = origem();
    const arquivo = {
      ...(o.arquivos[0] as OrigemAcervo["arquivos"][number]),
      esperado: { ...o.esperado, secoes: 99 },
    };
    expect(() => derivar({ ...entrada(o), arquivo })).toThrow(/esperadas 99 seções/);
    // sem o esperado do arquivo, vale o da origem (2 seções) e passa
    expect(() => derivar(entrada(o))).not.toThrow();
  });
});

// ───────────────────────── plano 02-27: lacunas declaradas, Gutenberg e charset ─────────────────────────

describe("conferirEsperado: unidade que a origem não traz só passa se estiver declarada (esperado.ausentes)", () => {
  const tei = parsearTei(Buffer.from(bruto).toString("utf8"));
  const esperado = origem().esperado;

  it("sem lacuna no arquivo e sem lacuna declarada: passa (é o caso do TEI)", () => {
    expect(conferirEsperado({ ...tei, ausentes: [] }, { ...esperado, ausentes: [] })).toEqual([]);
    expect(conferirEsperado(tei, esperado)).toEqual([]);
  });

  it("lacuna no arquivo que o registro NÃO declara reprova, nomeando a unidade", () => {
    const falhas = conferirEsperado({ ...tei, ausentes: ["18.65"] }, { ...esperado, ausentes: [] });
    expect(falhas.join(" ")).toMatch(/ausentes no arquivo/);
    expect(falhas.join(" ")).toMatch(/18\.65/);
  });

  it("lacuna declarada e não achada no arquivo também reprova (o registro não pode declarar o que não falta)", () => {
    const falhas = conferirEsperado(tei, { ...esperado, ausentes: ["18.65"] });
    expect(falhas.join(" ")).toMatch(/ausentes/);
  });

  it("lacuna igual à declarada passa, em qualquer ordem; conteúdo diferente reprova", () => {
    const r = { ...tei, ausentes: ["18.65", "18.66"] };
    expect(conferirEsperado(r, { ...esperado, ausentes: ["18.65", "18.66"] })).toEqual([]);
    expect(conferirEsperado(r, { ...esperado, ausentes: ["18.66", "18.65"] })).toEqual([]);
    expect(conferirEsperado(r, { ...esperado, ausentes: ["18.65"] }).length).toBeGreaterThan(0);
    expect(
      conferirEsperado(r, { ...esperado, ausentes: ["18.65", "18.67"] }).length,
    ).toBeGreaterThan(0);
  });

  it("total de parágrafos, quando declarado, é conferido no documento inteiro (os 114 ditos de Tomé)", () => {
    const total = tei.secoes.flatMap((s) => s.paragrafos).length;
    expect(total).toBe(4);
    expect(conferirEsperado(tei, { ...esperado, paragrafos_total: total })).toEqual([]);
    expect(conferirEsperado(tei, { ...esperado, paragrafos_total: total + 1 }).join(" ")).toMatch(
      /esperados 5 parágrafos no total, lidos 4/,
    );
  });
});

const PLINIO = readFileSync(path.join(FIXTURES, "gutenberg-plinio-trecho.txt"));
const DECLARACAO_PG =
  "Creating the works from public domain print editions means that no one owns a United States copyright in these works";
/** Numerais romanos de 1 a 200, para nomear as cartas que o recorte da fixture tirou. */
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
const CARTAS_TIRADAS = ROMANOS.slice(1, 96).map((n) => `trajano.${n}`);

function origemPlinio(mudar: Partial<OrigemAcervo> = {}): OrigemAcervo {
  return {
    ...origem(),
    nome: "Project Gutenberg eBook #2811 (teste)",
    fonte: "https://gutenberg.pglaf.org/2/8/1/2811/",
    commit: "0".repeat(64),
    formato: "gutenberg",
    verificador: { tradutores: ["William Melmoth", "F. C. T. Bosanquet"], licenca: DECLARACAO_PG },
    correspondencia_refs: { "trajano.XCVII": "10.96", "trajano.XCVIII": "10.97" },
    arquivos: [
      {
        id: "2811-8.txt",
        url: "https://gutenberg.pglaf.org/2/8/1/2811/2811-8.txt",
        slug: "plinio-cartas",
        idioma: "en",
        charset: "iso-8859-1",
        estrutura: "cartas",
        secoes: ["trajano"],
      },
    ],
    esperado: {
      secoes: 1,
      paragrafos: [
        {
          ref: "10.96",
          contem: ["Christians"],
          nao_contem: ["[1066]", "Project Gutenberg"],
          ref_inicio: undefined,
          ref_fim: undefined,
        },
        { ref: "10.97", contem: ["Christians"], nao_contem: [] },
      ],
      notas_fora_do_texto: true,
      ausentes: CARTAS_TIRADAS,
    },
    ...mudar,
  };
}
const entradaPlinio = (o = origemPlinio(), extra: Record<string, unknown> = {}) => ({
  origemId: "gutenberg-plinio-2811",
  origem: o,
  arquivo: o.arquivos[0] as OrigemAcervo["arquivos"][number],
  bruto: new Uint8Array(PLINIO),
  sha256Lock: sha(PLINIO),
  ...extra,
});

describe("derivar: Gutenberg (recorte real do Plínio)", () => {
  it("do bruto ao derivado: 10.96 e 10.97 pela tabela, sem nota nem licença no texto", () => {
    const d = derivar(entradaPlinio());
    expect(d.origem_id).toBe("gutenberg-plinio-2811");
    expect(d.origem_sha256).toBe(sha(PLINIO));
    expect(d.secoes.map((s) => s.slug)).toEqual(["trajano"]);
    expect(d.secoes[0]?.paragrafos.map((p) => p.ref)).toEqual(["trajano.I", "10.96", "10.97"]);
    const textos = d.secoes[0]?.paragrafos.map((p) => p.texto).join("\n") ?? "";
    expect(textos).toContain("Christians");
    expect(textos).not.toMatch(/\[\d+\]/);
    expect(textos).not.toContain("Creating the works");
  });

  it("lacuna no arquivo que o registro não declara derruba a derivação", () => {
    const o = origemPlinio();
    o.esperado = { ...o.esperado, ausentes: [] };
    expect(() => derivar(entradaPlinio(o))).toThrow(/ausentes no arquivo/);
  });

  it("entrada da tabela que não é carta do arquivo derruba a derivação: a numeração moderna nunca falha em silêncio", () => {
    const o = origemPlinio({ correspondencia_refs: { "trajano.XCIX": "10.98" } });
    expect(() => derivar(entradaPlinio(o))).toThrow(/correspondência/);
  });

  it("sem a tabela, 10.96 deixa de existir e o fato esperado derruba a derivação", () => {
    const o = origemPlinio({ correspondencia_refs: undefined });
    expect(() => derivar(entradaPlinio(o))).toThrow(/parágrafo 10\.96 ausente/);
  });

  it("o charset do registro é o que decodifica o bruto: ISO-8859-1 sai 'Cæsar'; os mesmos bytes como UTF-8 são recusados", () => {
    const texto = [
      "The Project Gutenberg EBook de Teste",
      "Translator: William Melmoth",
      "Editor: F. C. T. Bosanquet",
      "",
      "*** START OF THE PROJECT GUTENBERG EBOOK TESTE ***",
      "",
      "LETTERS GAIUS PLINIUS CAECILIUS SECUNDUS",
      "",
      "I -- To ALGUEM",
      "",
      "Cæsar wrote to the priests.",
      "",
      "FOOTNOTES TO THE LETTERS] 1 (return) [ Nota longa o bastante para a conferência de vazamento procurá-la.]",
      "",
      "*** END OF THE PROJECT GUTENBERG EBOOK TESTE ***",
      "",
      `${DECLARACAO_PG}, so the Foundation can copy.`,
      "",
    ].join("\n");
    const latin1 = Uint8Array.from(Array.from(texto, (c) => c.charCodeAt(0) & 0xff));
    const montar = (charset: "iso-8859-1" | "utf-8") =>
      entradaPlinio(
        origemPlinio({
          // documento sintético de uma carta só: sem tabela de correspondência
          correspondencia_refs: undefined,
          esperado: {
            secoes: 1,
            paragrafos: [{ ref: "trajano.I", contem: ["Cæsar wrote"], nao_contem: [] }],
            notas_fora_do_texto: true,
          },
        }),
        {
          bruto: latin1,
          sha256Lock: sha(latin1),
          arquivo: { ...(origemPlinio().arquivos[0] as object), charset },
        },
      );
    expect(derivar(montar("iso-8859-1")).secoes[0]?.paragrafos[0]?.texto).toBe(
      "Cæsar wrote to the priests.",
    );
    expect(() => derivar(montar("utf-8"))).toThrow(/utf-8|decodifica/);
  });
});
