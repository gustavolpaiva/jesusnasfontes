import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  conferirContagens,
  ErroConteudo,
  hashDoEstudo,
  lerPasta,
  prefixoDeAfirmacao,
} from "../../../scripts/content/esquema";

// O contrato dos arquivos de conteúdo: front matter, Divergência, Afirmações, capítulos e perguntas.
// Cada defeito falha nomeando o arquivo e o campo; cada um tem ao lado o caso correto que passa.

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const TRILHAS = [
  "- { id: base-historica, nome: Base histórica, ordem: 1, descricao: x }",
  "- { id: pontos-centrais, nome: Pontos centrais, ordem: 2, descricao: x }",
  "- { id: leitura-continua, nome: Leitura contínua, ordem: 3, descricao: x }",
].join("\n");

function pasta(arquivos: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jnf-esquema-"));
  temporarios.push(dir);
  mkdirSync(path.join(dir, "trilhas"), { recursive: true });
  writeFileSync(path.join(dir, "trilhas", "trilhas.yaml"), `${TRILHAS}\n`);
  for (const [nome, texto] of Object.entries(arquivos)) {
    mkdirSync(path.dirname(path.join(dir, nome)), { recursive: true });
    writeFileSync(path.join(dir, nome), texto);
  }
  return dir;
}

function estudo(extra = "", corpo = "## O que acontece\n\nTexto.", n = 3): string {
  return `---\nslug: estudo-${n}\ntrilha: pontos-centrais\nordem: ${n}\ntitulo: Estudo ${n}\nrecorte: devocional\n${extra}---\n\n${corpo}\n`;
}
const caminho = (n = 3) => `trilhas/pontos-centrais/${String(n).padStart(2, "0")}-estudo-${n}.md`;

const divergencia = (leituras: string) =>
  `divergencias:\n  - tema: Um tema\n    leituras:\n${leituras}`;
const leitura = (tradicao: string) =>
  `      - tradicao: ${tradicao}\n        resumo: Uma leitura.\n`;

async function falha(dir: string): Promise<string> {
  const erro = await lerPasta(dir).catch((e: unknown) => e);
  expect(erro).toBeInstanceOf(ErroConteudo);
  return (erro as Error).message;
}

describe("front matter e Divergência", () => {
  it("lê um Estudo com Divergência de duas e de três tradições", async () => {
    const dir = pasta({
      [caminho(3)]: estudo(divergencia(leitura("catolica") + leitura("protestante"))),
      [caminho(4)]: estudo(
        divergencia(leitura("catolica") + leitura("ortodoxa") + leitura("protestante")),
        "## O que acontece\n\nTexto.",
        4,
      ),
    });
    const lido = await lerPasta(dir);
    expect(lido.estudos.map((e) => e.frontMatter.divergencias[0]?.leituras.length)).toEqual([2, 3]);
  });

  it.each([
    ["tradição desconhecida", divergencia(leitura("catolica") + leitura("budista")), "tradicao"],
    ["uma leitura só", divergencia(leitura("catolica")), "leituras"],
    [
      "tradição repetida",
      divergencia(leitura("catolica") + leitura("catolica")),
      "tradição repetida",
    ],
    [
      "campo a mais",
      `${divergencia(leitura("catolica") + leitura("ortodoxa"))}outro: 1\n`,
      "outro",
    ],
  ])("recusa Divergência com %s, nomeando o arquivo e o campo", async (_nome, extra, trecho) => {
    const mensagem = await falha(pasta({ [caminho()]: estudo(extra) }));
    expect(mensagem).toContain("03-estudo-3.md");
    expect(mensagem).toContain(trecho);
  });

  it("recusa front matter inválido com o arquivo e o campo", async () => {
    const mensagem = await falha(
      pasta({ [caminho()]: estudo().replace("recorte: devocional", "recorte: cinza") }),
    );
    expect(mensagem).toContain("03-estudo-3.md");
    expect(mensagem).toContain("recorte");
  });

  it("o hash do Estudo muda com a Divergência", async () => {
    const a = await lerPasta(pasta({ [caminho()]: estudo() }));
    const b = await lerPasta(
      pasta({ [caminho()]: estudo(divergencia(leitura("catolica") + leitura("ortodoxa"))) }),
    );
    expect(a.estudos[0]?.conteudoHash).not.toBe(b.estudos[0]?.conteudoHash);
    const fm = a.estudos[0]?.frontMatter;
    if (!fm) throw new Error("sem Estudo");
    expect(hashDoEstudo(fm, "x", [])).not.toBe(hashDoEstudo(fm, "y", []));
  });
});

describe("Afirmações no Estudo", () => {
  it("aceita o id do próprio Estudo e extrai a Afirmação", async () => {
    const dir = pasta({
      [caminho(3)]: estudo("", "## O que acontece\n\n:afirmacao[Uma frase]{#pc03-a1}."),
    });
    const lido = await lerPasta(dir);
    expect(lido.estudos[0]?.afirmacoes.map((a) => a.id)).toEqual(["pc03-a1"]);
  });

  it("o prefixo vem da Trilha e da posição do Estudo", () => {
    expect(prefixoDeAfirmacao("pontos-centrais", 3)).toBe("pc03");
    expect(prefixoDeAfirmacao("base-historica", 12)).toBe("bh12");
    expect(prefixoDeAfirmacao("leitura-continua", 1)).toBeNull();
  });

  it("recusa id de outro Estudo, id fora do padrão e id repetido entre Estudos", async () => {
    const outro = await falha(
      pasta({ [caminho(3)]: estudo("", "## O que acontece\n\n:afirmacao[Uma]{#pc04-a1}.") }),
    );
    expect(outro).toContain("03-estudo-3.md");
    expect(outro).toContain("pc03-a");
    const base = await falha(
      pasta({ [caminho(3)]: estudo("", "## O que acontece\n\n:afirmacao[Uma]{#bh03-a1}.") }),
    );
    expect(base).toContain("pc03-a");
    const padrao = await falha(
      pasta({ [caminho(3)]: estudo("", "## O que acontece\n\n:afirmacao[Uma]{#xx03-a1}.") }),
    );
    expect(padrao).toContain("fora do padrão");
    const repetido = await falha(
      pasta({
        [caminho(3)]: estudo(
          "",
          "## O que acontece\n\n:afirmacao[Uma]{#pc03-a1}.\n\n:afirmacao[Duas]{#pc03-a1}.",
        ),
      }),
    );
    expect(repetido).toContain("id repetido");
  });
});

describe("Leitura contínua: capitulos.yaml e perguntas", () => {
  const capitulo = (slug: string, livro: number, cap: number, ordem: number) =>
    `- slug: ${slug}\n  livro: ${livro}\n  capitulo: ${cap}\n  titulo: Capítulo ${ordem}\n  ordem: ${ordem}\n  foco: "O que há aqui."\n`;
  const CAPS = "trilhas/leitura-continua/capitulos.yaml";
  const perguntas = (conjuntos: number, porConjunto = 3) =>
    Array.from(
      { length: conjuntos },
      (_, c) =>
        `-\n${Array.from({ length: porConjunto }, (_p, i) => `  - "C${c} P${i}?"`).join("\n")}\n`,
    ).join("");

  it("gera um Estudo por capítulo, com a Passagem do capítulo inteiro, livro e capítulo", async () => {
    const dir = pasta({
      [CAPS]: capitulo("mateus-5", 40, 5, 1) + capitulo("marcos-5", 41, 5, 2),
      "perguntas/leitura-continua.yaml": perguntas(3),
    });
    const lido = await lerPasta(dir);
    expect(lido.estudos.map((e) => [e.frontMatter.slug, e.livro, e.capitulo])).toEqual([
      ["mateus-5", 40, 5],
      ["marcos-5", 41, 5],
    ]);
    expect(lido.estudos[0]?.corpo).toBe("## O que há neste capítulo\n\nO que há aqui.");
    expect(lido.estudos[0]?.passagens).toHaveLength(1);
    expect(lido.estudos[0]?.passagens[0]?.inicio).toBe(40005001);
    expect(lido.perguntas).toHaveLength(3);
  });

  it.each([
    ["livro inexistente", capitulo("x-1", 99, 1, 1), "0.livro"],
    ["capítulo além do livro", capitulo("mateus-29", 40, 29, 1), "28 capítulos"],
    ["slug repetido", capitulo("a", 40, 1, 1) + capitulo("a", 40, 2, 2), "slug repetido"],
    ["ordem repetida", capitulo("a", 40, 1, 1) + capitulo("b", 40, 2, 1), "ordem repetida"],
    ["campo a mais", `${capitulo("a", 40, 1, 1)}  extra: 1\n`, "extra"],
  ])("recusa capitulos.yaml com %s, nomeando o arquivo", async (_nome, yaml, trecho) => {
    const mensagem = await falha(pasta({ [CAPS]: yaml }));
    expect(mensagem).toContain("capitulos.yaml");
    expect(mensagem).toContain(trecho);
  });

  it("recusa arquivo .md solto na pasta da Leitura contínua", async () => {
    const mensagem = await falha(
      pasta({ [CAPS]: capitulo("a", 40, 1, 1), "trilhas/leitura-continua/01-solto.md": "x" }),
    );
    expect(mensagem).toContain("01-solto.md");
    expect(mensagem).toContain("capitulos.yaml");
  });

  it.each([
    ["dois conjuntos", perguntas(2)],
    ["quatro conjuntos", perguntas(4)],
    ["conjunto de duas perguntas", perguntas(3, 2)],
  ])("recusa perguntas com %s", async (_nome, yaml) => {
    const mensagem = await falha(
      pasta({ [CAPS]: capitulo("a", 40, 1, 1), "perguntas/leitura-continua.yaml": yaml }),
    );
    expect(mensagem).toContain("perguntas/leitura-continua.yaml");
  });

  it("sem o arquivo de perguntas a leitura devolve null", async () => {
    const lido = await lerPasta(pasta({ [CAPS]: capitulo("a", 40, 1, 1) }));
    expect(lido.perguntas).toBeNull();
  });
});

describe("conferirContagens: 8, 30, 89 e 3 conjuntos de 3", () => {
  const completo = () => {
    const estudos = [
      ...Array.from({ length: 8 }, () => "base-historica"),
      ...Array.from({ length: 30 }, () => "pontos-centrais"),
      ...Array.from({ length: 89 }, () => "leitura-continua"),
    ].map((trilha) => ({ frontMatter: { trilha } }));
    return {
      trilhas: [],
      estudos,
      perguntas: [
        ["a", "b", "c"],
        ["a", "b", "c"],
        ["a", "b", "c"],
      ],
    } as unknown as Parameters<typeof conferirContagens>[0];
  };

  it("passa com as contagens do contrato", () => {
    expect(() => conferirContagens(completo())).not.toThrow();
  });

  it("falha nomeando a Trilha que não confere e as perguntas que faltam", () => {
    const menos = completo();
    menos.estudos.pop();
    expect(() => conferirContagens(menos)).toThrow(
      /leitura-continua: esperado 89 Estudos, achados 88/,
    );
    const semPerguntas = { ...completo(), perguntas: null };
    expect(() => conferirContagens(semPerguntas)).toThrow(/3 conjuntos de 3 perguntas/);
    const incompleto = { ...completo(), perguntas: [["a", "b", "c"]] };
    expect(() => conferirContagens(incompleto)).toThrow(/3 conjuntos de 3 perguntas/);
  });
});
