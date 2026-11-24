import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Guarda da classe de defeito "a tela junta partes de dois estados" (revisão cruzada do 02-16 para fichas e do 02-19
// para Citações). Propriedade: toda leitura que monta UMA resposta com MAIS DE UMA consulta sobre dado que pode mudar
// ao mesmo tempo lê tudo no mesmo instantâneo (`{ instantaneo: true }`: REPEATABLE READ, só leitura), ou está na lista
// abaixo com o motivo. A medição é estática e conservadora: em cada chamada de porta de banco (`comAcervo`,
// `comAdmin`, `comEstudante`, `porta`) conta as referências ao `tx` dentro da função passada; duas ou mais = "várias
// consultas" (um auxiliar que recebe o `tx` conta como consulta). Chamada que escreve fica fora (escrita não é
// escopo; ela já trava por conta própria). A tabela completa está em
// `.planning/phases/02-acervo/medicoes/leituras-instantaneo.md`.

const RAIZ = join(process.cwd(), "src", "modules");
const PORTAS = new Set(["comAcervo", "comAdmin", "comEstudante", "porta"]);
// Escrita: o construtor de consultas, a fila por Estudante ou uma função do banco que grava (`select acervo.salvar_...`).
const ESCREVE =
  /\.(insert|update|delete)\(|travarProgresso|pg_advisory|for update|select\s+acervo\.\w+\(/i;

/** Leituras com várias consultas que NÃO usam o instantâneo, cada uma com o motivo medido. Sem entrada, reprova. */
const PERMITIDAS: Record<string, string> = {
  "privacidade/exportar.ts::exportarDados":
    "pega a trava por Estudante ANTES de ler; o instantâneo de REPEATABLE READ nasce na primeira consulta (o set_config da " +
    "porta), antes de a trava esperar, e leria o estado de ANTES da escrita que a trava aguardou. A fila é o que dá a " +
    "consistência aqui.",
};

type Achado = {
  arquivo: string;
  funcao: string;
  consultas: number;
  escreve: boolean;
  instantaneo: boolean;
};

function nomeDaFuncao(no: ts.Node): string {
  for (let p: ts.Node | undefined = no.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  }
  return "(topo do arquivo)";
}

function ehInstantaneo(args: readonly ts.Expression[]): boolean {
  return args.some(
    (a) =>
      ts.isObjectLiteralExpression(a) &&
      a.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          ts.isIdentifier(p.name) &&
          p.name.text === "instantaneo" &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      ),
  );
}

/** Chamadas às portas de banco de um arquivo, com o que a função passada faz. Exportada para o controle negativo. */
function medir(texto: string, arquivo: string): Achado[] {
  const fonte = ts.createSourceFile(arquivo, texto, ts.ScriptTarget.Latest, true);
  const achados: Achado[] = [];
  const visitar = (no: ts.Node): void => {
    if (
      ts.isCallExpression(no) &&
      ts.isIdentifier(no.expression) &&
      PORTAS.has(no.expression.text)
    ) {
      const funcaoPassada = no.arguments.find(
        (a): a is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      );
      const parametro = funcaoPassada?.parameters[0]?.name;
      if (funcaoPassada && parametro && ts.isIdentifier(parametro)) {
        let referencias = 0;
        const contar = (n: ts.Node): void => {
          if (ts.isIdentifier(n) && n.text === parametro.text) referencias++;
          ts.forEachChild(n, contar);
        };
        contar(funcaoPassada.body);
        achados.push({
          arquivo,
          funcao: nomeDaFuncao(no),
          consultas: referencias,
          escreve: ESCREVE.test(funcaoPassada.body.getText(fonte)),
          instantaneo: ehInstantaneo(no.arguments),
        });
      }
    }
    ts.forEachChild(no, visitar);
  };
  visitar(fonte);
  return achados;
}

/** As chamadas que quebram a propriedade: leitura com várias consultas, sem instantâneo e fora da lista. */
function violacoes(achados: readonly Achado[]): Achado[] {
  return achados.filter(
    (a) =>
      a.consultas >= 2 &&
      !a.escreve &&
      !a.instantaneo &&
      !(`${a.arquivo}::${a.funcao}` in PERMITIDAS),
  );
}

function arquivosTs(pasta: string): string[] {
  return readdirSync(pasta).flatMap((nome) => {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) return arquivosTs(caminho);
    return /\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

const todos = arquivosTs(RAIZ).flatMap((caminho) =>
  medir(readFileSync(caminho, "utf8"), relative(RAIZ, caminho)),
);

describe("leituras de várias consultas leem num só instantâneo", () => {
  it("controle positivo: o medidor enxerga as leituras que já usam o instantâneo", () => {
    const estudo = todos.filter((a) => a.arquivo === "conteudo/estudo.ts");
    expect(estudo.find((a) => a.funcao === "lerEstudoSemPassagens")).toMatchObject({
      instantaneo: true,
    });
    expect(
      todos.find((a) => a.arquivo === "acervo/consultas-ficha.ts" && a.funcao === "lerFicha"),
    ).toMatchObject({ instantaneo: true });
    expect(todos.filter((a) => a.instantaneo).length).toBeGreaterThanOrEqual(8);
  });

  it("controle negativo: leitura de duas consultas sem instantâneo é acusada; com ele, ou escrevendo, não", () => {
    const base = (opcoes: string, corpo = "") => `
      export async function lerAlgo() {
        return comAcervo(async (tx) => {
          const a = await tx.select().from(x);
          const b = await tx.select().from(y);${corpo}
          return [a, b];
        }${opcoes});
      }`;
    expect(violacoes(medir(base(""), "x.ts"))).toHaveLength(1);
    expect(violacoes(medir(base(", { instantaneo: true }"), "x.ts"))).toHaveLength(0);
    expect(violacoes(medir(base(", { instantaneo: false }"), "x.ts"))).toHaveLength(1);
    expect(violacoes(medir(base("", "await tx.insert(z).values({});"), "x.ts"))).toHaveLength(0);
    const uma = `export async function lerUma() { return comAcervo((tx) => tx.select().from(x)); }`;
    expect(violacoes(medir(uma, "x.ts"))).toHaveLength(0);
  });

  it("nenhuma leitura de várias consultas escapa do instantâneo sem estar na lista com motivo", () => {
    expect(violacoes(todos).map((a) => `${a.arquivo}::${a.funcao}`)).toEqual([]);
  });

  it("a lista de exceções não guarda entrada que já não existe ou que já usa o instantâneo", () => {
    for (const chave of Object.keys(PERMITIDAS)) {
      const achado = todos.find((a) => `${a.arquivo}::${a.funcao}` === chave);
      expect(achado, `${chave} sumiu: tire da lista`).toBeDefined();
      expect(achado?.consultas, `${chave} já tem uma consulta só: tire da lista`).toBeGreaterThan(
        1,
      );
      expect(achado?.instantaneo, `${chave} já usa o instantâneo: tire da lista`).toBe(false);
    }
  });

  it("o Grau e as Citações só são lidos por quem está no instantâneo: único chamador de lerCitacoesAprovadas", () => {
    const chamadores = arquivosTs(RAIZ)
      .filter((c) => !c.endsWith(join("acervo", "citacoes.ts")))
      .filter((c) => /\blerCitacoesAprovadas\(/.test(readFileSync(c, "utf8")))
      .map((c) => relative(RAIZ, c));
    expect(chamadores).toEqual(["conteudo/estudo.ts"]);
    expect(
      todos.find((a) => a.arquivo === "conteudo/estudo.ts" && a.funcao === "lerEstudoSemPassagens")
        ?.instantaneo,
    ).toBe(true);
  });
});
