// Evidência do tradutor (plano 02-11): o trecho que o registro fixa tem de existir no parágrafo `ref` do BRUTO, e o
// registro só aceita a evidência completa (referência, nome esperado e trecho juntos).

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { derivarParaDisco } from "../../../scripts/ingest/acervo-derivar";
import {
  conferirEvidenciaNoBruto,
  textoDoElementoPorId,
} from "../../../scripts/ingest/acervo-evidencia";
import { lerOrigens } from "../../../scripts/ingest/acervo-origens";
import { verificarAcervo } from "../../../scripts/ingest/acervo-verificar";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "acervo",
);
const bruto = new Uint8Array(readFileSync(path.join(FIXTURES, "ccel-lightfoot-obras.thml")));
const SHA = createHash("sha256").update(bruto).digest("hex");
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

describe("textoDoElementoPorId", () => {
  const xml =
    '<doc><p id="a1">Translated by <i>S.   Thelwall</i>,\n late of X.</p><p id="a2">Outro.</p></doc>';
  it("devolve o texto visível do elemento, com os espaços fechados", () => {
    expect(textoDoElementoPorId(xml, "a1")).toBe("Translated by S. Thelwall, late of X.");
    expect(textoDoElementoPorId(xml, "a2")).toBe("Outro.");
  });
  it("id que não existe dá null", () => {
    expect(textoDoElementoPorId(xml, "a3")).toBeNull();
  });
});

describe("conferirEvidenciaNoBruto", () => {
  const lido = {
    secoes: [{ paragrafos: [{ ref: "p1", texto: "Translated by S. Thelwall, late." }] }],
  };
  const xml =
    '<doc><p id="p1">Translated by S. Thelwall, late.</p><p id="fora">Prefácio de J. Roberts.</p></doc>';
  const conferir = (ref: string, trecho: string) =>
    conferirEvidenciaNoBruto(xml, lido as never, { ref, trecho });

  it("passa quando o parágrafo existe e traz o trecho exato (na leitura ou direto no arquivo)", () => {
    expect(conferir("p1", "Translated by S. Thelwall")).toBeNull();
    expect(conferir("fora", "Prefácio de J. Roberts")).toBeNull();
  });
  it("parágrafo inexistente reprova", () => {
    expect(conferir("p9", "Translated by S. Thelwall")).toMatch(/p9 não existe no bruto/);
  });
  it("trecho que o parágrafo não tem reprova, dizendo o que o parágrafo diz", () => {
    const motivo = conferir("p1", "Translated by W. Whiston");
    expect(motivo).toMatch(/não contém o trecho/);
    expect(motivo).toContain("Translated by S. Thelwall, late.");
  });
});

describe("registro: a evidência do tradutor vem completa", () => {
  const origem = (arquivo: Record<string, unknown>) => ({
    "ccel-lightfoot-fathers": {
      nome: "CCEL (teste)",
      autores: ["CCEL"],
      licenca: "Domínio público",
      url_licenca: "https://ccel.org/ccel/lightfoot/fathers.xml",
      fonte: "https://ccel.org/ccel/lightfoot/fathers",
      commit: "bd5be3b8c8435787a48f402ba31ffae240ebb5ad09ef1efcab99e7471744a4f9",
      data_versao: "2026-11-24",
      alteracoes: "Nenhuma.",
      formato: "thml",
      publicavel: true,
      motivo: "teste",
      arquivos: [
        {
          id: "fathers.xml",
          url: "https://ccel.org/ccel/lightfoot/fathers.xml",
          slug: "didaque",
          idioma: "en",
          divisao_secao: "div2",
          divisoes: ["ii.xii"],
          ...arquivo,
        },
      ],
      verificador: { editores: ["Lightfoot, Joseph Barber (1828-1889)"], licenca: "Public Domain" },
      esperado: { secoes: 3, paragrafos: [], notas_fora_do_texto: true },
    },
  });
  const ler = (arquivo: Record<string, unknown>) => {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-evidencia-"));
    temporarios.push(raiz);
    const caminho = path.join(raiz, "origens.yaml");
    writeFileSync(caminho, JSON.stringify(origem(arquivo)));
    return () => lerOrigens(caminho);
  };

  it("os três campos juntos passam; qualquer um faltando reprova", () => {
    const completo = {
      evidencia_tradutor: "ii.xii-p1",
      tradutor_esperado: ["J. Smith"],
      evidencia_trecho: "Translated by J. Smith",
    };
    expect(ler(completo)).not.toThrow();
    for (const campo of Object.keys(completo)) {
      const incompleto: Record<string, unknown> = { ...completo };
      delete incompleto[campo];
      expect(ler(incompleto)).toThrow(/três campos juntos/);
    }
  });
});

describe("acervo:verify prova o trecho da evidência no bruto", () => {
  function montar(extra: Record<string, unknown>) {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-evidencia-verify-"));
    temporarios.push(raiz);
    const opcoes = {
      origens: path.join(raiz, "origens.yaml"),
      lockBruto: path.join(raiz, "acervo.lock.json"),
      bruto: path.join(raiz, "raw"),
      derivados: path.join(raiz, "derivados"),
      lockDerivados: path.join(raiz, "derivados.lock.json"),
    };
    const registro = {
      "ccel-lightfoot-fathers": {
        nome: "CCEL (teste)",
        autores: ["CCEL"],
        licenca: "Domínio público",
        url_licenca: "https://ccel.org/ccel/lightfoot/fathers.xml",
        fonte: "https://ccel.org/ccel/lightfoot/fathers",
        commit: "bd5be3b8c8435787a48f402ba31ffae240ebb5ad09ef1efcab99e7471744a4f9",
        data_versao: "2026-11-24",
        alteracoes: "Nenhuma.",
        formato: "thml",
        publicavel: true,
        motivo: "teste",
        arquivos: [
          {
            id: "fathers.xml",
            url: "https://ccel.org/ccel/lightfoot/fathers.xml",
            slug: "didaque",
            idioma: "en",
            divisao_secao: "div2",
            divisoes: ["ii.xii"],
            ...extra,
          },
        ],
        verificador: {
          editores: ["Lightfoot, Joseph Barber (1828-1889)"],
          licenca: "Public Domain",
        },
        esperado: { secoes: 3, paragrafos: [], notas_fora_do_texto: true },
      },
    };
    writeFileSync(opcoes.origens, JSON.stringify(registro));
    writeFileSync(
      opcoes.lockBruto,
      JSON.stringify({ arquivos: { "ccel-lightfoot-fathers/fathers.xml": SHA } }),
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
    derivarParaDisco("didaque", opcoes);
    return opcoes;
  }
  const evidencia = (ref: string, trecho: string) => ({
    evidencia_tradutor: ref,
    tradutor_esperado: ["Lightfoot"],
    evidencia_trecho: trecho,
  });

  it("parágrafo que existe e traz o trecho: OK, saída 0", () => {
    const r = verificarAcervo(montar(evidencia("ii.xii-p1", "There are two ways, one of life")));
    expect(r.codigo).toBe(0);
  });

  it("referência que não existe no bruto reprova (saída 1)", () => {
    const r = verificarAcervo(montar(evidencia("ii.xii-p99", "There are two ways")));
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(
      /REPROVADO .*didaque: evidencia_tradutor: .*ii\.xii-p99 não existe/,
    );
  });

  it("trecho que o parágrafo não tem reprova (saída 1)", () => {
    const r = verificarAcervo(montar(evidencia("ii.xii-p1", "Translated by William Whiston")));
    expect(r.codigo).toBe(1);
    expect(r.linhas.join("\n")).toMatch(/não contém o trecho do registro/);
  });
});
