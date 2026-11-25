import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  lerOpcoes,
  posicoesDosRetidos,
  TETO_DE_REMOCOES_POR_FONTE,
  TETO_DE_UNIDADES_POR_FONTE,
} from "../../../scripts/acervo/carregar";
import { CAMINHO_LOCK, lerLock } from "../../../scripts/acervo/derivados";
import { shaDaEntrada, YAML_NAO_TRAVADO } from "../../../scripts/acervo/entrada";
import { travar } from "../../../scripts/acervo/travar-yaml";
import { linhasDeConflito, PASSO_DO_ACERVO } from "../../../scripts/db/build-producao";
import { yamlSha256DoArquivo } from "../../support/entrada";

// As opções do comando que o build NUNCA usa (`--remover`, `--teto`, `--teto-remocoes`), a conta das posições dos itens
// retidos, e o lock que versiona a ENTRADA da carga (derivado e YAML): plano 02-22, revisões cruzadas.

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

describe("opções do acervo:load", () => {
  it("sem opção nenhuma não autoriza remoção nem muda os tetos: é o que o build faz", () => {
    const o = lerOpcoes([]);
    expect(o.remover).toBeUndefined();
    expect(o.teto).toBeUndefined();
    expect(o.tetoDeRemocoes).toBeUndefined();
    // O passo do build não passa argumento algum ao carregador.
    expect(PASSO_DO_ACERVO.argumentos).toEqual([]);
    expect(TETO_DE_UNIDADES_POR_FONTE).toBe(250);
    expect(TETO_DE_REMOCOES_POR_FONTE).toBe(50);
  });

  it("--remover só aceita autorização TIPADA: secao:<slug>/<seção> ou paragrafo:<slug>/<ref>", () => {
    expect(
      lerOpcoes(["--remover", "paragrafo:josefo-antiguidades/18.65,secao:josefo-antiguidades/20"])
        .remover,
    ).toEqual(["paragrafo:josefo-antiguidades/18.65", "secao:josefo-antiguidades/20"]);
    // Sem tipo, o mesmo id valeria para a seção e para o parágrafo: recusado.
    for (const ruim of [
      "josefo-antiguidades/18.65",
      "18.65",
      "capitulo:josefo-antiguidades/1",
      "secao:Josefo/1",
      "secao:josefo-antiguidades/",
      "paragrafo:",
      "",
    ])
      expect(() => lerOpcoes(["--remover", ruim]), JSON.stringify(ruim)).toThrow();
    expect(() => lerOpcoes(["--remover"])).toThrow(/Uso/);
  });

  it("--teto e --teto-remocoes são inteiros maiores que zero", () => {
    expect(lerOpcoes(["--teto", "5000"]).teto).toBe(5000);
    expect(lerOpcoes(["--teto-remocoes", "7"]).tetoDeRemocoes).toBe(7);
    for (const flag of ["--teto", "--teto-remocoes"])
      for (const ruim of ["0", "-1", "1.5", "abc"])
        expect(() => lerOpcoes([flag, ruim]), `${flag} ${ruim}`).toThrow(new RegExp(flag));
  });
});

describe("posicoesDosRetidos (o retido nunca herda a posição de quem o derivado inseriu)", () => {
  const retidos = (...ordens: number[]) => ordens.map((o) => ({ id: `r${o}`, ordem: o }));
  const final = (usadas: number[], r: ReturnType<typeof retidos>) => {
    const m = posicoesDosRetidos(new Set(usadas), r);
    return Object.fromEntries(r.map((x) => [x.id, m.get(x.id)]));
  };

  it("o exemplo da revisão: A/B/C e o derivado A/C (posições 1 e 2): B, que estava na 2, vai para a 3", () => {
    expect(final([1, 2], retidos(2))).toEqual({ r2: 3 });
  });

  it("o retido que não colide fica onde está", () => {
    expect(final([1, 2], retidos(3))).toEqual({ r3: 3 });
    expect(final([1, 2, 3], retidos(7))).toEqual({ r7: 7 });
  });

  it("vários retidos e inserções entre eles: nenhuma posição se repete, e os que colidem vão para o fim na ordem em que estavam", () => {
    // Banco 1..6; o derivado ficou com 1,2,3,4 e ganhou posições entre os retidos.
    const r = retidos(2, 3, 5, 6);
    const m = posicoesDosRetidos(new Set([1, 2, 3, 4]), r);
    expect(m.get("r5")).toBe(5);
    expect(m.get("r6")).toBe(6);
    expect(m.get("r2")).toBe(7);
    expect(m.get("r3")).toBe(8);
    const todas = [1, 2, 3, 4, ...m.values()];
    expect(new Set(todas).size).toBe(todas.length);
  });

  it("propriedade: para qualquer mistura, as posições finais (derivado e retidos) são todas distintas", () => {
    let semente = 12345;
    const aleatorio = (n: number) => {
      semente = (semente * 1103515245 + 12345) & 0x7fffffff;
      return semente % n;
    };
    for (let rodada = 0; rodada < 300; rodada++) {
      const usadas = new Set<number>();
      for (let i = 0, n = aleatorio(12); i < n; i++) usadas.add(1 + aleatorio(15));
      const ordens = new Set<number>();
      for (let i = 0, n = aleatorio(10); i < n; i++) ordens.add(1 + aleatorio(20));
      const r = retidos(...ordens);
      const m = posicoesDosRetidos(usadas, r);
      const todas = [...usadas, ...m.values()];
      expect(
        new Set(todas).size,
        JSON.stringify({ usadas: [...usadas], ordens: [...ordens] }),
      ).toBe(todas.length);
      for (const x of r) expect(m.get(x.id)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("o lock dos derivados guarda a ENTRADA (derivado e YAML)", () => {
  const FONTES_YAML = path.join("content", "acervo", "fontes");

  function montar(comYaml: "nenhum" | "naoTravado" | "travado"): {
    lock: string;
    fontes: string;
    derivados: string;
  } {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-travar-"));
    temporarios.push(raiz);
    const fontes = path.join(raiz, "fontes");
    const derivados = path.join(raiz, "derivados");
    mkdirSync(fontes);
    mkdirSync(derivados);
    for (const nome of ["josefo-antiguidades.yaml"])
      cpSync(path.join("tests", "fixtures", "acervo", "fontes", nome), path.join(fontes, nome));
    const conteudo = '{"slug":"josefo-antiguidades"}';
    writeFileSync(path.join(derivados, "josefo-antiguidades.json"), conteudo);
    const entrada: Record<string, unknown> = {
      sha256: sha(conteudo),
      bytes: Buffer.byteLength(conteudo),
    };
    if (comYaml === "naoTravado") entrada.yaml_sha256 = YAML_NAO_TRAVADO;
    if (comYaml === "travado")
      entrada.yaml_sha256 = yamlSha256DoArquivo(path.join(fontes, "josefo-antiguidades.yaml"));
    entrada.revisao = 3;
    const lock = path.join(raiz, "lock.json");
    writeFileSync(
      lock,
      `${JSON.stringify({ orcamento_arquivo_bytes: 100000, orcamento_total_bytes: 1000000, derivados: { "josefo-antiguidades": entrada } }, null, 2)}\n`,
    );
    return { lock, fontes, derivados };
  }

  it("lock sem `yaml_sha256` ou sem `revisao` não é lido (o build não carrega lock no formato antigo)", () => {
    const { lock } = montar("nenhum");
    expect(() => lerLock(lock)).toThrow(/yaml_sha256/);
  });

  it("YAML ainda não travado (ausente ou zerado): recebe o sha256 do YAML e a revisão NÃO sobe", () => {
    for (const antes of ["nenhum", "naoTravado"] as const) {
      const { lock, fontes } = montar(antes);
      const r = travar(lock, fontes);
      expect(r).toEqual({ travadas: ["josefo-antiguidades"], revisadas: [] });
      const e = lerLock(lock).derivados["josefo-antiguidades"];
      expect(e?.revisao).toBe(3);
      expect(e?.yaml_sha256).toBe(
        yamlSha256DoArquivo(path.join(fontes, "josefo-antiguidades.yaml")),
      );
    }
  });

  it("YAML editado depois de travado: o sha256 muda e a revisão SOBE em 1; sem edição, nada muda", () => {
    const { lock, fontes } = montar("travado");
    const antes = readFileSync(lock, "utf8");
    expect(travar(lock, fontes)).toEqual({ travadas: [], revisadas: [] });
    expect(readFileSync(lock, "utf8")).toBe(antes);
    const arquivo = path.join(fontes, "josefo-antiguidades.yaml");
    writeFileSync(
      arquivo,
      readFileSync(arquivo, "utf8").replace(/^titulo: .*$/m, "titulo: Outro título"),
    );
    expect(travar(lock, fontes)).toEqual({ travadas: [], revisadas: ["josefo-antiguidades"] });
    const e = lerLock(lock).derivados["josefo-antiguidades"];
    expect(e?.revisao).toBe(4);
    expect(e?.yaml_sha256).toBe(yamlSha256DoArquivo(arquivo));
  });

  it("o sha256 do derivado e os bytes nunca são tocados por `acervo:travar`", () => {
    const { lock, fontes, derivados } = montar("nenhum");
    const conteudo = readFileSync(path.join(derivados, "josefo-antiguidades.json"));
    const antes = lerLockBruto(lock);
    travar(lock, fontes);
    const depois = lerLock(lock).derivados["josefo-antiguidades"];
    expect(depois?.sha256).toBe(antes.sha256);
    expect(depois?.bytes).toBe(antes.bytes);
    expect(sha(conteudo)).toBe(antes.sha256);
  });

  it("o YAML sem derivado no lock é ignorado; derivado no lock sem YAML derruba", () => {
    const { lock, fontes } = montar("travado");
    rmSync(path.join(fontes, "josefo-antiguidades.yaml"));
    expect(() => travar(lock, fontes)).toThrow(/não há YAML/);
  });

  it("o sha256 da entrada junta o do derivado e o do YAML: mudar qualquer um muda a entrada", () => {
    const base = shaDaEntrada("d".repeat(64), "y".repeat(64));
    expect(shaDaEntrada("e".repeat(64), "y".repeat(64))).not.toBe(base);
    expect(shaDaEntrada("d".repeat(64), "z".repeat(64))).not.toBe(base);
    expect(shaDaEntrada("d".repeat(64), "y".repeat(64))).toBe(base);
  });

  it("o lock DO PRODUTO confere com os YAMLs de Fonte versionados (quem edita um YAML roda pnpm acervo:travar)", () => {
    const lock = lerLock(CAMINHO_LOCK);
    for (const [slug, e] of Object.entries(lock.derivados))
      expect(e.yaml_sha256, `${slug}: rode pnpm acervo:travar`).toBe(
        yamlSha256DoArquivo(path.join(FONTES_YAML, `${slug}.yaml`)),
      );
  });
});

function lerLockBruto(caminho: string): { sha256: string; bytes: number } {
  const bruto = JSON.parse(readFileSync(caminho, "utf8")) as {
    derivados: Record<string, { sha256: string; bytes: number }>;
  };
  return bruto.derivados["josefo-antiguidades"] as { sha256: string; bytes: number };
}

describe("o aviso do build", () => {
  it("as linhas `recusada:` (teto) entram junto com as `conflito:` (painel); aviso de revisão mais nova não", () => {
    const saida = [
      "aviso: x: o banco já tem a revisão 2 da entrada e este build traz a 1; a carga não a tocou.",
      "recusada: y escreveria 300 unidades, acima do teto de 250 por Fonte; nada foi escrito nela.",
      "conflito: z foi editada no painel (limites_pt); a carga não a tocou.",
    ].join("\n");
    expect(linhasDeConflito(saida)).toEqual([
      "recusada: y escreveria 300 unidades, acima do teto de 250 por Fonte; nada foi escrito nela.",
      "conflito: z foi editada no painel (limites_pt); a carga não a tocou.",
    ]);
  });
});
