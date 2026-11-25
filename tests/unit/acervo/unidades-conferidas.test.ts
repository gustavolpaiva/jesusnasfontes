// `unidades_conferidas` (revisão cruzada do plano 02-04): uma origem pode restringir o que se publica a uma lista
// fechada de unidades, cada uma conferida contra a edição de domínio público. O derivador emite só elas e o
// `acervo:verify` reprova derivado com unidade de fora e lista vazia. Origem sem a lista segue como sempre.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { derivar, derivarParaDisco } from "../../../scripts/ingest/acervo-derivar";
import type { OrigemAcervo } from "../../../scripts/ingest/acervo-origens";
import { verificarAcervo } from "../../../scripts/ingest/acervo-verificar";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const brutoTacito = readFileSync(
  path.join(RAIZ, "tests", "fixtures", "acervo", "perseus-tacito-trecho.xml"),
);
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const ARQ = "phi1351.phi005.perseus-eng2.xml";
const ID = "perseus-latinlit-tacito";
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const origemTacito = (mudar: Partial<OrigemAcervo> = {}): OrigemAcervo => ({
  nome: "Perseus (Tácito, teste)",
  autores: ["Perseus"],
  licenca: "CC BY-SA 4.0",
  url_licenca: "https://creativecommons.org/licenses/by-sa/4.0/",
  fonte: "https://github.com/PerseusDL/canonical-latinLit",
  commit: "8cef51623130f2412da410858e32c322eb796c0a",
  data_versao: "2026-11-24",
  alteracoes: "Notas de editor removidas.",
  formato: "tei",
  publicavel: true,
  motivo: "teste",
  arquivos: [
    {
      id: ARQ,
      url: "https://raw.githubusercontent.com/PerseusDL/canonical-latinLit/8cef51623130f2412da410858e32c322eb796c0a/x.xml",
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
  ...mudar,
});

const entrada = (o: OrigemAcervo) => ({
  origemId: ID,
  origem: o,
  arquivo: o.arquivos[0] as OrigemAcervo["arquivos"][number],
  bruto: new Uint8Array(brutoTacito),
  sha256Lock: sha(brutoTacito),
});

const refs = (d: ReturnType<typeof derivar>) =>
  d.secoes.flatMap((s) => s.paragrafos.map((p) => p.ref));

function cenario(o: OrigemAcervo) {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-unidades-"));
  temporarios.push(raiz);
  const opcoes = {
    origens: path.join(raiz, "origens.yaml"),
    lockBruto: path.join(raiz, "acervo.lock.json"),
    bruto: path.join(raiz, "raw"),
    derivados: path.join(raiz, "derivados"),
    lockDerivados: path.join(raiz, "derivados.lock.json"),
  };
  writeFileSync(opcoes.origens, JSON.stringify({ [ID]: o }));
  writeFileSync(
    opcoes.lockBruto,
    JSON.stringify({ arquivos: { [`${ID}/${ARQ}`]: sha(brutoTacito) } }),
  );
  writeFileSync(
    opcoes.lockDerivados,
    JSON.stringify({
      orcamento_arquivo_bytes: 8_388_608,
      orcamento_total_bytes: 31_457_280,
      derivados: {},
    }),
  );
  mkdirSync(path.join(opcoes.bruto, ID), { recursive: true });
  writeFileSync(path.join(opcoes.bruto, ID, ARQ), brutoTacito);
  return { raiz, opcoes };
}

const rodar = (o: ReturnType<typeof cenario>["opcoes"]) =>
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

describe("derivar com unidades_conferidas", () => {
  it("sem a lista a origem deriva tudo, como sempre (o trecho tem 15.43, 15.44 e 15.45)", () => {
    expect(refs(derivar(entrada(origemTacito())))).toEqual(["15.43", "15.44", "15.45"]);
  });

  it("com a lista só sai a unidade conferida: 15.44", () => {
    const d = derivar(entrada(origemTacito({ unidades_conferidas: ["15.44"] })));
    expect(refs(d)).toEqual(["15.44"]);
    expect(d.secoes).toHaveLength(1);
  });

  it("o bruto inteiro continua conferido: `esperado` impossível ainda derruba a derivação restrita", () => {
    const o = origemTacito({ unidades_conferidas: ["15.44"] });
    o.esperado = { ...o.esperado, secoes: 12 };
    expect(() => derivar(entrada(o))).toThrow(/esperadas 12 seções/);
  });

  it("lista vazia recusa (nunca vale como 'tudo')", () => {
    expect(() => derivar(entrada(origemTacito({ unidades_conferidas: [] })))).toThrow(
      /unidades_conferidas vazia/,
    );
  });

  it("unidade da lista que o bruto não tem recusa (typo não vira derivado menor em silêncio)", () => {
    expect(() =>
      derivar(entrada(origemTacito({ unidades_conferidas: ["15.44", "15.99"] }))),
    ).toThrow(/ausente no bruto: 15\.99/);
  });

  it("derivarParaDisco grava só a unidade conferida", () => {
    const { opcoes } = cenario(origemTacito({ unidades_conferidas: ["15.44"] }));
    derivarParaDisco("tacito-anais", opcoes);
    const d = JSON.parse(readFileSync(path.join(opcoes.derivados, "tacito-anais.json"), "utf8"));
    expect(
      d.secoes.flatMap((s: { paragrafos: { ref: string }[] }) => s.paragrafos.map((p) => p.ref)),
    ).toEqual(["15.44"]);
  });
});

describe("acervo:verify com unidades_conferidas", () => {
  it("controle positivo: derivado restrito e bruto íntegros saem 0 e reproduzem", () => {
    const { opcoes } = cenario(origemTacito({ unidades_conferidas: ["15.44"] }));
    derivarParaDisco("tacito-anais", opcoes);
    const p = rodar(opcoes);
    expect(p.status).toBe(0);
    expect(p.stdout).toMatch(/reproduz a partir do bruto/);
  });

  it("controle negativo: derivado com unidade a mais (15.43, 15.45) sai 1 e nomeia as unidades de fora", () => {
    const { raiz, opcoes } = cenario(origemTacito({ unidades_conferidas: ["15.44"] }));
    // O derivado "largo" vem da mesma origem SEM a lista, é posto no lugar e o lock acompanha (hash e bytes):
    // só a regra da lista pode reprová-lo, não o lock nem a adulteração.
    const larga = cenario(origemTacito());
    derivarParaDisco("tacito-anais", larga.opcoes);
    mkdirSync(opcoes.derivados, { recursive: true });
    const destino = path.join(opcoes.derivados, "tacito-anais.json");
    copyFileSync(path.join(larga.opcoes.derivados, "tacito-anais.json"), destino);
    const conteudo = readFileSync(destino);
    writeFileSync(
      opcoes.lockDerivados,
      JSON.stringify({
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: 31_457_280,
        derivados: {
          "tacito-anais": { sha256: sha(conteudo), bytes: conteudo.byteLength, revisao: 1 },
        },
      }),
    );
    expect(raiz).toBeTruthy();
    const p = rodar(opcoes);
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(
      /REPROVADO tacito-anais: .*2 unidade\(s\) fora de unidades_conferidas.*15\.43, 15\.45/,
    );
  });

  it("lista vazia no registro reprova mesmo sem derivado", () => {
    const { opcoes } = cenario(origemTacito({ unidades_conferidas: [] }));
    const p = rodar(opcoes);
    expect(p.status).toBe(1);
    expect(p.stdout).toMatch(/REPROVADO perseus-latinlit-tacito: unidades_conferidas vazia/);
  });

  it("controle positivo: origem sem a lista segue verde com o derivado inteiro", () => {
    const { opcoes } = cenario(origemTacito());
    derivarParaDisco("tacito-anais", opcoes);
    expect(verificarAcervo(opcoes).codigo).toBe(0);
  });
});
