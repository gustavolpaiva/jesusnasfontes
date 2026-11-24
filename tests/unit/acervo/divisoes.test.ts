// `divisoes` por arquivo (formato `thml`): um volume do CCEL que reúne várias obras (a coleção de Lightfoot)
// vira VÁRIAS Fontes — cada entrada de `arquivos` do registro lista as divisões do nível da seção que lhe
// pertencem. O bruto inteiro continua conferido (`esperado` da origem sobre o arquivo completo); só as
// divisões listadas saem no derivado, e divisão listada e ausente reprova (typo nunca vira derivado menor).

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { derivar, derivarParaDisco } from "../../../scripts/ingest/acervo-derivar";
import {
  type ArquivoOrigem,
  lerOrigens,
  type OrigemAcervo,
} from "../../../scripts/ingest/acervo-origens";
import { verificarAcervo } from "../../../scripts/ingest/acervo-verificar";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const bruto = new Uint8Array(readFileSync(path.join(FIXTURES, "ccel-lightfoot-obras.thml")));
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const SHA_BRUTO = sha(bruto);
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const arquivo = (mudar: Partial<ArquivoOrigem> = {}): ArquivoOrigem => ({
  id: "fathers.xml",
  url: "https://ccel.org/ccel/lightfoot/fathers.xml",
  slug: "didaque",
  idioma: "en",
  divisao_secao: "div2",
  ...mudar,
});

const origem = (arquivos: ArquivoOrigem[], mudar: Partial<OrigemAcervo> = {}): OrigemAcervo => ({
  nome: "CCEL, The Apostolic Fathers, de J. B. Lightfoot (teste)",
  autores: ["Joseph Barber Lightfoot (tradução)", "CCEL (edição digital)"],
  licenca: "Domínio público, como declara o cabeçalho do próprio arquivo",
  url_licenca: "https://ccel.org/ccel/lightfoot/fathers.xml",
  fonte: "https://ccel.org/ccel/lightfoot/fathers",
  commit: "bd5be3b8c8435787a48f402ba31ffae240ebb5ad09ef1efcab99e7471744a4f9",
  data_versao: "2026-11-24",
  alteracoes: "Notas de editor removidas do texto.",
  formato: "thml",
  publicavel: true,
  motivo: "DC.Rights 'Public Domain' lido no cabeçalho",
  arquivos,
  verificador: { tradutores: ["Lightfoot, Joseph Barber (1828-1889)"], licenca: "Public Domain" },
  esperado: {
    secoes: 3,
    paragrafos: [
      { ref: "ii.i-p1", contem: ["The Church of God which sojourneth in Rome"], nao_contem: [] },
      { ref: "ii.xii-p1", contem: ["There are two ways"], nao_contem: [] },
      { ref: "ii.xv-p1", contem: ["most excellent Diognetus"], nao_contem: [] },
    ],
    notas_fora_do_texto: true,
  },
  ...mudar,
});

const entrada = (o: OrigemAcervo, a: ArquivoOrigem) => ({
  origemId: "ccel-lightfoot-fathers",
  origem: o,
  arquivo: a,
  bruto,
  sha256Lock: SHA_BRUTO,
});

describe("derivar com divisões por arquivo", () => {
  it("emite só as divisões listadas, com o slug kebab do id e a ordem do arquivo inteiro", () => {
    const a = arquivo({ divisoes: ["ii.xii"] });
    const d = derivar(entrada(origem([a]), a));
    expect(d.slug).toBe("didaque");
    expect(d.secoes).toHaveLength(1);
    expect(d.secoes[0]?.slug).toBe("ii-xii");
    expect(d.secoes[0]?.titulo).toBe("Didache");
    // A ordem é a da divisão no arquivo lido (na fixture, ii.xii é a 2ª divisão; no volume real, a 12ª),
    // como a unidade 15.44 do Tácito guarda o livro 15: o recorte não renumera.
    expect(d.secoes[0]?.ordem).toBe(2);
    expect(d.secoes[0]?.paragrafos.map((p) => p.ref)).toEqual(["ii.xii-p1", "ii.xii-p2"]);
  });

  it("várias divisões numa só Fonte (o caso das sete cartas de Inácio), na ordem do volume", () => {
    const a = arquivo({ slug: "inacio-cartas", divisoes: ["ii.xii", "ii.xv"] });
    const d = derivar(entrada(origem([a]), a));
    expect(d.secoes.map((s) => s.slug)).toEqual(["ii-xii", "ii-xv"]);
    expect(d.secoes.map((s) => s.ordem)).toEqual([2, 3]);
  });

  it("o bruto inteiro continua conferido: o esperado da origem vale para cada Fonte", () => {
    const a = arquivo({ divisoes: ["ii.xii"] });
    const o = origem([a], { esperado: { secoes: 4, paragrafos: [], notas_fora_do_texto: true } });
    expect(() => derivar(entrada(o, a))).toThrow(/esperadas 4 seções, lidas 3/);
  });

  it("divisão listada e ausente no bruto reprova nomeando a divisão", () => {
    const a = arquivo({ divisoes: ["ii.xii", "ii.xvi"] });
    expect(() => derivar(entrada(origem([a]), a))).toThrow(/ausente no bruto: ii\.xvi/);
  });

  it("divisão repetida na lista reprova (nunca vale como duas)", () => {
    const a = arquivo({ divisoes: ["ii.xii", "ii.xii"] });
    expect(() => derivar(entrada(origem([a]), a))).toThrow(/divisão repetida/);
  });
});

describe("registro: contrato de divisoes", () => {
  it("lista vazia reprova no contrato do registro", () => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-divisoes-"));
    temporarios.push(raiz);
    const caminho = path.join(raiz, "origens.yaml");
    const comVazia = origem([arquivo({ divisoes: [] })]);
    writeFileSync(caminho, JSON.stringify({ "ccel-lightfoot-fathers": comVazia }));
    expect(() => lerOrigens(caminho)).toThrow(/fora do contrato/);
  });
});

describe("acervo:verify com várias Fontes do mesmo arquivo", () => {
  function montar(divisoesDidaque: string[]) {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-divisoes-verify-"));
    temporarios.push(raiz);
    const opcoes = {
      origens: path.join(raiz, "origens.yaml"),
      lockBruto: path.join(raiz, "acervo.lock.json"),
      bruto: path.join(raiz, "raw"),
      derivados: path.join(raiz, "derivados"),
      lockDerivados: path.join(raiz, "derivados.lock.json"),
    };
    const registro = {
      "ccel-lightfoot-fathers": origem([
        arquivo({ divisoes: divisoesDidaque }),
        arquivo({ slug: "diogneto", divisoes: ["ii.xv"] }),
      ]),
    };
    writeFileSync(opcoes.origens, JSON.stringify(registro));
    writeFileSync(
      opcoes.lockBruto,
      JSON.stringify({ arquivos: { "ccel-lightfoot-fathers/fathers.xml": SHA_BRUTO } }),
    );
    writeFileSync(
      opcoes.lockDerivados,
      JSON.stringify({
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: 31_457_280,
        derivados: {},
      }),
    );
    mkdirSync(path.join(opcoes.bruto, "ccel-lightfoot-fathers"), { recursive: true });
    writeFileSync(path.join(opcoes.bruto, "ccel-lightfoot-fathers", "fathers.xml"), bruto);
    return { opcoes };
  }

  it("duas Fontes do mesmo bruto saem 0, cada uma com as suas divisões, e o TOTAIS aparece uma vez", () => {
    const { opcoes } = montar(["ii.xii"]);
    derivarParaDisco("didaque", opcoes);
    derivarParaDisco("diogneto", opcoes);
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(0);
    const saida = r.linhas.join("\n");
    expect(saida).toMatch(/OK didaque \(/);
    expect(saida).toMatch(
      /OK ccel-lightfoot-fathers\/fathers\.xml \(1 seções, 1 parágrafos, notas fora\) — diogneto/,
    );
    expect(saida).toMatch(/OK didaque reproduz a partir do bruto/);
    expect(saida).toMatch(/OK diogneto reproduz a partir do bruto/);
    // O volume é um arquivo só: o total de caracteres aparece uma única vez, não uma por Fonte.
    expect(saida.match(/TOTAIS ccel-lightfoot-fathers\/fathers\.xml/g)).toHaveLength(1);
    expect(saida).not.toContain("REPROVADO");
  });

  it("derivado com seção fora das divisões do arquivo reprova (registro estreito de volta)", () => {
    const { opcoes } = montar(["ii.xii"]);
    derivarParaDisco("didaque", opcoes);
    derivarParaDisco("diogneto", opcoes);
    // Alguém amplia o registro, rederiva e depois o registro volta a ser estreito: o derivado commitado
    // tem uma seção que o arquivo desta Fonte não autoriza mais.
    const ampliado = JSON.parse(readFileSync(opcoes.origens, "utf8"));
    ampliado["ccel-lightfoot-fathers"].arquivos[0].divisoes = ["ii.xii", "ii.xv"];
    writeFileSync(opcoes.origens, JSON.stringify(ampliado));
    derivarParaDisco("didaque", opcoes);
    const estreito = JSON.parse(readFileSync(opcoes.origens, "utf8"));
    estreito["ccel-lightfoot-fathers"].arquivos[0].divisoes = ["ii.xii"];
    writeFileSync(opcoes.origens, JSON.stringify(estreito));
    const r = verificarAcervo(opcoes);
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(
      /REPROVADO didaque: .*fora das divisões do arquivo \(ii-xv\)/,
    );
  });
});
