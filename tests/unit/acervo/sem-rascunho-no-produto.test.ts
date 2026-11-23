import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// D-17: rascunho de ficha nunca viaja no repositório público do produto. Aqui o que se prova: não existe a pasta de
// fichas em `content/acervo/` e nenhum YAML sob `content/acervo/` traz a chave de estado de ficha. Quem carrega
// rascunho aponta uma pasta de FORA (`--fichas`), que o carregador exige.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTEUDO_ACERVO = path.join(RAIZ, "content", "acervo");
const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

function yamlsDe(pasta: string): string[] {
  let entradas: import("node:fs").Dirent[];
  try {
    entradas = readdirSync(pasta, { withFileTypes: true });
  } catch (erro) {
    if ((erro as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw erro;
  }
  return entradas.flatMap((e) =>
    e.isDirectory()
      ? yamlsDe(path.join(pasta, e.name))
      : /\.ya?ml$/.test(e.name)
        ? [path.join(pasta, e.name)]
        : [],
  );
}

/** Arquivos YAML sob a pasta que trazem a chave de estado ou de origem de rascunho de ficha. */
function comChaveDeFicha(pasta: string): string[] {
  return yamlsDe(pasta).filter((arquivo) =>
    /^(estado|origem_do_rascunho)\s*:/m.test(readFileSync(arquivo, "utf8")),
  );
}

describe("nenhum rascunho de ficha no repositório do produto", () => {
  it("não existe content/acervo/fichas", () => {
    let existe = true;
    try {
      readdirSync(path.join(CONTEUDO_ACERVO, "fichas"));
    } catch (erro) {
      if ((erro as NodeJS.ErrnoException).code !== "ENOENT") throw erro;
      existe = false;
    }
    expect(existe).toBe(false);
  });

  it("nenhum YAML sob content/acervo tem a chave de estado de ficha", () => {
    expect(comChaveDeFicha(CONTEUDO_ACERVO)).toEqual([]);
  });

  it("controle negativo: o detector acusa um YAML de ficha posto na pasta", () => {
    const pasta = mkdtempSync(path.join(tmpdir(), "jnf-sem-rascunho-"));
    temporarios.push(pasta);
    mkdirSync(path.join(pasta, "fichas"));
    writeFileSync(path.join(pasta, "fichas", "x.yaml"), "slug: x\nestado: rascunho\n");
    writeFileSync(path.join(pasta, "fonte.yaml"), "slug: y\ntipo_texto: integral\n");
    expect(comChaveDeFicha(pasta).map((a) => path.basename(a))).toEqual(["x.yaml"]);
    expect(yamlsDe(pasta)).toHaveLength(2);
  });
});
