import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lerOpcoes, TETO_DE_UNIDADES_POR_FONTE } from "../../../scripts/acervo/carregar";
import { lerLock } from "../../../scripts/acervo/derivados";
import { adicionarRevisao, executar } from "../../../scripts/acervo/lock-adicionar-revisao";
import { linhasDeConflito, PASSO_DO_ACERVO } from "../../../scripts/db/build-producao";

// As opções do comando que o build NUNCA usa (`--remover`, `--teto`), o passo único que acrescentou `revisao` ao lock
// sem tocar nos derivados, e a recusa de lock sem `revisao` (plano 02-22, revisão cruzada).

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

describe("opções do acervo:load", () => {
  it("sem opção nenhuma não autoriza remoção nem muda o teto: é o que o build faz", () => {
    const o = lerOpcoes([]);
    expect(o.remover).toBeUndefined();
    expect(o.teto).toBeUndefined();
    // O passo do build não passa argumento algum ao carregador.
    expect(PASSO_DO_ACERVO.argumentos).toEqual([]);
    expect(TETO_DE_UNIDADES_POR_FONTE).toBe(250);
  });

  it("--remover recebe uma lista de ids da forma <slug>/<seção ou ref>", () => {
    expect(
      lerOpcoes(["--remover", "josefo-antiguidades/18.65,josefo-antiguidades/20"]).remover,
    ).toEqual(["josefo-antiguidades/18.65", "josefo-antiguidades/20"]);
    for (const ruim of [
      "18.65",
      "Josefo/18.65",
      "josefo-antiguidades/",
      "josefo antiguidades/1",
      "",
    ])
      expect(() => lerOpcoes(["--remover", ruim]), JSON.stringify(ruim)).toThrow();
    expect(() => lerOpcoes(["--remover"])).toThrow(/Uso/);
  });

  it("--teto é um inteiro maior que zero", () => {
    expect(lerOpcoes(["--teto", "5000"]).teto).toBe(5000);
    for (const ruim of ["0", "-1", "1.5", "abc"])
      expect(() => lerOpcoes(["--teto", ruim]), ruim).toThrow(/--teto/);
  });
});

describe("o aviso do build", () => {
  it("as linhas `recusada:` (teto) entram junto com as `conflito:` (painel); aviso de revisão mais nova não", () => {
    const saida = [
      "aviso: x: o banco já tem a revisão 2 do derivado e este build traz a 1; a carga não a tocou.",
      "recusada: y escreveria 300 unidades, acima do teto de 250 por Fonte; nada foi escrito nela.",
      "conflito: z foi editada no painel (limites_pt); a carga não a tocou.",
    ].join("\n");
    expect(linhasDeConflito(saida)).toEqual([
      "recusada: y escreveria 300 unidades, acima do teto de 250 por Fonte; nada foi escrito nela.",
      "conflito: z foi editada no painel (limites_pt); a carga não a tocou.",
    ]);
  });
});

describe("o lock dos derivados", () => {
  function montar(comRevisao: boolean) {
    const raiz = mkdtempSync(path.join(tmpdir(), "jnf-lock-revisao-"));
    temporarios.push(raiz);
    const pasta = path.join(raiz, "derivados");
    mkdirSync(pasta);
    const entradas: Record<string, Record<string, unknown>> = {};
    for (const slug of ["alfa", "beta"]) {
      const conteudo = `{"slug":"${slug}"}`;
      writeFileSync(path.join(pasta, `${slug}.json`), conteudo);
      entradas[slug] = {
        sha256: sha(conteudo),
        bytes: Buffer.byteLength(conteudo),
        ...(comRevisao ? { revisao: 3 } : {}),
      };
    }
    const lock = path.join(raiz, "lock.json");
    writeFileSync(
      lock,
      `${JSON.stringify({ orcamento_arquivo_bytes: 100, orcamento_total_bytes: 1000, derivados: entradas }, null, 2)}\n`,
    );
    return { lock, pasta };
  }

  it("lock sem `revisao` não é lido (o build não carrega lock no formato antigo)", () => {
    const { lock } = montar(false);
    expect(() => lerLock(lock)).toThrow(/derivados\.alfa\.revisao/);
  });

  it("o passo único acrescenta revisao: 1 a cada entrada e não muda um byte de nenhum derivado", () => {
    const { lock, pasta } = montar(false);
    const antes = ["alfa", "beta"].map((s) => readFileSync(path.join(pasta, `${s}.json`)));
    expect(executar(lock, pasta)).toEqual({ derivados: 2 });
    const lido = lerLock(lock);
    expect(lido.derivados.alfa?.revisao).toBe(1);
    expect(lido.derivados.beta?.revisao).toBe(1);
    const depois = ["alfa", "beta"].map((s) => readFileSync(path.join(pasta, `${s}.json`)));
    expect(depois.map((b) => sha(b))).toEqual(antes.map((b) => sha(b)));
    // sha256 e bytes do lock são os mesmos de antes.
    expect(lido.derivados.alfa?.sha256).toBe(sha(antes[0] as Buffer));
  });

  it("recusa lock que já tem revisao (rodar duas vezes) e não escreve", () => {
    const { lock, pasta } = montar(true);
    const antes = readFileSync(lock, "utf8");
    expect(() => executar(lock, pasta)).toThrow(/já tem revisao/);
    expect(readFileSync(lock, "utf8")).toBe(antes);
  });

  it("recusa derivado que não confere com o lock, sem escrever", () => {
    const { lock, pasta } = montar(false);
    writeFileSync(path.join(pasta, "alfa.json"), '{"slug":"adulterado"}');
    const antes = readFileSync(lock, "utf8");
    expect(() => executar(lock, pasta)).toThrow(/não confere/);
    expect(readFileSync(lock, "utf8")).toBe(antes);
  });

  it("adicionarRevisao só acrescenta o campo", () => {
    const novo = adicionarRevisao({
      orcamento_arquivo_bytes: 1,
      orcamento_total_bytes: 2,
      derivados: { a: { sha256: "x", bytes: 3 } },
    });
    expect(novo).toEqual({
      orcamento_arquivo_bytes: 1,
      orcamento_total_bytes: 2,
      derivados: { a: { sha256: "x", bytes: 3, revisao: 1 } },
    });
  });
});
