// O registro REAL (`data/acervo-origens.yaml`) contra os brutos reais em cache, derivando para uma pasta
// temporária (nunca toca `data/acervo-derivados`). Sem o cache do bruto (máquina sem `acervo:baixar`) o teste
// pula: é passo de desenvolvedor, como o `SEM BRUTO` do `acervo:verify`.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { derivarParaDisco } from "../../../scripts/ingest/acervo-derivar";
import {
  caminhoDoBruto,
  lerOrigens,
  PASTA_BRUTO,
  unidadesPermitidas,
} from "../../../scripts/ingest/acervo-origens";

const origens = lerOrigens();
const temBruto = (origemId: string, arquivoId: string) =>
  existsSync(caminhoDoBruto(PASTA_BRUTO, origemId, arquivoId));
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

function derivarReal(slug: string) {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-real-"));
  temporarios.push(raiz);
  const lockDerivados = path.join(raiz, "derivados.lock.json");
  writeFileSync(
    lockDerivados,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {},
    }),
  );
  const derivados = path.join(raiz, "derivados");
  const r = derivarParaDisco(slug, { derivados, lockDerivados });
  const d = JSON.parse(readFileSync(path.join(derivados, `${slug}.json`), "utf8")) as {
    secoes: { paragrafos: { ref: string }[] }[];
  };
  return { ...r, unidades: d.secoes.flatMap((s) => s.paragrafos.map((p) => p.ref)) };
}

describe("registro real: Tácito é excerto de uma unidade", () => {
  it("o registro restringe o Tácito a 15.44 e as demais origens não restringem", () => {
    expect([...(unidadesPermitidas(origens["perseus-latinlit-tacito"] as never) ?? [])]).toEqual([
      "15.44",
    ]);
    expect(unidadesPermitidas(origens["perseus-greeklit-josefo"] as never)).toBeUndefined();
    expect(unidadesPermitidas(origens["perseus-greeklit-luciano"] as never)).toBeUndefined();
  });

  it.skipIf(!temBruto("perseus-latinlit-tacito", "phi1351.phi005.perseus-eng2.xml"))(
    "derivar tacito-anais emite 1 unidade (antes da correção emitia 721)",
    () => {
      expect(derivarReal("tacito-anais").unidades).toEqual(["15.44"]);
    },
  );
});

describe("registro real: controle positivo, o resto do Acervo não muda", () => {
  it.skipIf(!temBruto("perseus-greeklit-josefo", "tlg0526.tlg001.perseus-eng2.xml"))(
    "Antiguidades: 1.444 parágrafos e os mesmos bytes do derivado versionado (sha256 do lock)",
    () => {
      const r = derivarReal("josefo-antiguidades");
      expect(r.unidades).toHaveLength(1444);
      const lock = JSON.parse(readFileSync("data/acervo-derivados.lock.json", "utf8"));
      expect(r.sha256).toBe(lock.derivados["josefo-antiguidades"].sha256);
    },
  );

  it.skipIf(!temBruto("perseus-greeklit-josefo", "tlg0526.tlg004.perseus-eng2.xml"))(
    "Guerra dos Judeus: 707 parágrafos",
    () => {
      expect(derivarReal("josefo-guerra-judaica").unidades).toHaveLength(707);
    },
  );

  it.skipIf(!temBruto("perseus-greeklit-luciano", "tlg0062.tlg042.perseus-eng4.xml"))(
    "Luciano, Peregrino: 45 parágrafos",
    () => {
      expect(derivarReal("luciano-peregrino").unidades).toHaveLength(45);
    },
  );
});
