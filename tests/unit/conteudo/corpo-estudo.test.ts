import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CorpoEstudo } from "@/modules/conteudo/corpo-estudo";
import type { EstudoCompleto } from "@/modules/conteudo/estudo";

// O corpo do Estudo renderizado no servidor, sem navegador: o que o Markdown do conteúdo vira.

function estudo(corpoMd: string, resto: Partial<EstudoCompleto> = {}): EstudoCompleto {
  return {
    id: "e1",
    slug: "teste",
    trilha: { id: "pontos-centrais", nome: "Pontos centrais", ordem: 2 },
    ordem: 1,
    grupo: null,
    titulo: "Teste",
    recorte: "devocional",
    minutos: 3,
    corpoMd,
    grauDeCerteza: null,
    passagens: [],
    afirmacoes: [],
    divergencias: [],
    perguntas: [],
    ...resto,
  };
}

const html = (e: EstudoCompleto, volta?: number) =>
  renderToStaticMarkup(
    createElement(CorpoEstudo, volta === undefined ? { estudo: e } : { estudo: e, volta }),
  );

describe("CorpoEstudo: Markdown", () => {
  it("rebaixa o h1 do Markdown a h2: a tela tem um só h1", () => {
    const saida = html(estudo("# Um título\n\nTexto do estudo."));
    expect(saida).not.toContain("<h1");
    expect(saida).toMatch(/<h2[^>]*>Um título<\/h2>/);
    expect(saida).toContain("Texto do estudo.");
  });

  it("não deixa o remark-directive comer o ':13' de 'Mt 3:13' nem o ':1' de 'Gl 1:18-19'", () => {
    const saida = html(estudo("## O ponto\n\nLeia Mt 3:13 e Jo 3:16, depois Gálatas 1:18-19."));
    expect(saida).toContain("Mt 3:13");
    expect(saida).toContain("Jo 3:16");
    expect(saida).toContain("Gálatas 1:18-19");
  });

  it("HTML cru vira texto escapado, nunca marcação", () => {
    const saida = html(
      estudo(
        "## O ponto\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\nTexto <b>forte</b> e <i>itálico</i>.",
      ),
    );
    expect(saida).not.toContain("<script");
    expect(saida).not.toContain("<img");
    expect(saida).not.toContain("<b>");
    expect(saida).not.toContain("<i>");
    expect(saida).toContain("&lt;script&gt;");
  });

  it("link e imagem do Markdown mostram só o texto", () => {
    const saida = html(
      estudo(
        "## O ponto\n\nVeja [um link](https://exemplo.test) e ![uma imagem](https://exemplo.test/a.png) aqui.",
      ),
    );
    expect(saida).not.toContain("<a ");
    expect(saida).not.toContain("<img");
    expect(saida).not.toContain("exemplo.test");
    expect(saida).toContain("um link");
  });

  it("deixa uma diretiva desconhecida com rótulo como texto, nunca como marcação", () => {
    const saida = html(estudo("## O ponto\n\nTexto :nome[rótulo] fim."));
    expect(saida).toContain(":nome[rótulo]");
  });
});

describe("CorpoEstudo: Afirmação e chip (TRIL-07)", () => {
  const corpo = [
    "## O que acontece",
    "",
    ":afirmacao[Pilatos governou a Judeia]{#pc01-a1}. Depois veio outra coisa.",
    "",
    "## Pontos centrais",
    "",
    "- :afirmacao[Primeira]{#pc01-a2}",
    "- Sem marca.",
    "- :afirmacao[Um]{#pc01-a3} e :afirmacao[dois]{#pc01-a4} no mesmo item.",
  ].join("\n");

  it("mostra o chip depois do bloco, um por Afirmação, e ordinal só quando o bloco tem mais de uma", () => {
    const saida = html(estudo(corpo));
    expect(saida.match(/data-slot="chip-fonte"/g)).toHaveLength(4);
    expect(saida).toContain("Fonte em preparação</span>");
    expect(saida).toContain("Fonte em preparação · 1</span>");
    expect(saida).toContain("Fonte em preparação · 2</span>");
    // O chip vem depois do texto da frase do mesmo bloco.
    expect(saida.indexOf("Pilatos governou a Judeia")).toBeLessThan(saida.indexOf("chip-fonte"));
    // A frase leva o mesmo número em sup quando há mais de uma no bloco, e só aí.
    expect(saida.match(/<sup/g)).toHaveLength(2);
    expect(saida).toMatch(/Um<sup[^>]*>1<\/sup>/);
    expect(saida).toMatch(/dois<sup[^>]*>2<\/sup>/);
  });

  it("a frase não ganha sublinhado nem cor, e o chip não é botão nem link", () => {
    const saida = html(estudo(corpo));
    const frase = /<span data-afirmacao-id="pc01-a1">[^<]*<\/span>/.exec(saida);
    expect(frase).not.toBeNull();
    expect(saida).not.toMatch(/data-afirmacao-id="[^"]*"[^>]*class=/);
    const chip = /<span data-slot="chip-fonte"[^>]*>/.exec(saida)?.[0] ?? "";
    expect(chip).not.toMatch(/role=|tabindex|href|onclick/i);
    expect(chip).toContain("border-dashed");
  });

  it("o resumo recolhido vem uma vez só, antes da primeira seção que tem Afirmação", () => {
    const saida = html(estudo(`## O ponto\n\nSem marca aqui.\n\n${corpo}`));
    expect(saida.match(/O que é “Fonte em preparação”\?/g)).toHaveLength(1);
    expect(saida.indexOf("O que é “Fonte em preparação”?")).toBeGreaterThan(
      saida.indexOf("Sem marca aqui."),
    );
    expect(saida.indexOf("O que é “Fonte em preparação”?")).toBeLessThan(
      saida.indexOf("Pilatos governou"),
    );
    expect(saida).toContain('aria-expanded="false"');
  });

  it("sem Afirmação não há resumo nem chip", () => {
    const saida = html(estudo("## O ponto\n\nSó texto."));
    expect(saida).not.toContain("chip-fonte");
    expect(saida).not.toContain("O que é “Fonte em preparação”?");
  });
});

describe("CorpoEstudo: capitular", () => {
  const c = (md: string) => html(estudo(md)).includes("first-letter:float-left");
  it("vale quando o primeiro caractere do primeiro parágrafo é uma letra", () => {
    expect(c("## O ponto\n\nJesus é batizado.")).toBe(true);
    expect(c("## O ponto\n\n:afirmacao[Jesus é batizado]{#pc01-a1}.")).toBe(true);
    expect(c("## O ponto\n\nÁguas e luz.")).toBe(true);
  });
  it("não vale quando começa por número, aspas ou « »", () => {
    expect(c("## O ponto\n\n12 apóstolos.")).toBe(false);
    expect(c("## O ponto\n\n“Vem e vê”, disse.")).toBe(false);
    expect(c('## O ponto\n\n"Vem e vê", disse.')).toBe(false);
    expect(c("## O ponto\n\n«Vem» e vê.")).toBe(false);
    expect(c("## O ponto\n\n- Item de lista antes.")).toBe(false);
  });
});

describe("CorpoEstudo: perguntas da Leitura contínua e a volta", () => {
  const perguntas = [
    ["a1", "a2", "a3"],
    ["b1", "b2", "b3"],
    ["c1", "c2", "c3"],
  ];
  const cap = (volta?: number) =>
    html(
      estudo("## O que há neste capítulo\n\nTexto.", {
        trilha: { id: "leitura-continua", nome: "Leitura contínua", ordem: 3 },
        perguntas,
      }),
      volta,
    );

  it("a volta 1 (e a ausência de volta) usa o primeiro conjunto e não mostra rótulo", () => {
    for (const saida of [cap(), cap(1)]) {
      expect(saida).toContain("Três perguntas para responder");
      expect(saida).toContain("<li>a1</li>");
      expect(saida).not.toContain("b1");
      expect(saida).not.toContain("data-volta");
    }
  });

  it("a volta v usa o conjunto (v - 1) mod 3 e mostra 'volta v' quando v > 1", () => {
    expect(cap(2)).toContain("<li>b1</li>");
    expect(cap(2)).toMatch(/data-volta[^>]*>volta 2</);
    expect(cap(3)).toContain("<li>c1</li>");
    expect(cap(4)).toContain("<li>a1</li>");
    expect(cap(4)).toMatch(/data-volta[^>]*>volta 4</);
    expect(cap(5)).toContain("<li>b1</li>");
  });

  it("outras Trilhas não mostram perguntas, mesmo que os dados cheguem", () => {
    const saida = html(estudo("## O ponto\n\nTexto.", { perguntas }));
    expect(saida).not.toContain("Três perguntas");
  });
});

describe("CorpoEstudo: Divergência (TRIL-08)", () => {
  const d = (ordemDoArquivo: ("catolica" | "ortodoxa" | "protestante")[]) =>
    html(
      estudo("## O ponto\n\nTexto.", {
        divergencias: [
          {
            tema: "Um tema",
            leituras: ordemDoArquivo.map((t) => ({ tradicao: t, resumo: `Leitura ${t}.` })),
          },
        ],
      }),
    );

  it("mostra a introdução fixa e as tradições nomeadas, sempre na ordem católica, ortodoxa, protestante", () => {
    for (const ordem of [
      ["catolica", "ortodoxa", "protestante"],
      ["protestante", "ortodoxa", "catolica"],
    ] as const) {
      const saida = d([...ordem]);
      expect(saida).toContain(
        "Cristãos de tradições diferentes leem este ponto de formas diferentes. Mostramos cada leitura, sem escolher uma.",
      );
      const a = saida.indexOf("Tradição católica");
      const b = saida.indexOf("Tradição ortodoxa");
      const c = saida.indexOf("Tradição protestante");
      expect(a).toBeGreaterThan(-1);
      expect(a).toBeLessThan(b);
      expect(b).toBeLessThan(c);
      expect(saida.match(/<h3[^>]*>Tradição/g)).toHaveLength(3);
    }
  });

  it("com duas tradições faz duas colunas iguais; nenhuma leva cor de acento", () => {
    const saida = d(["catolica", "protestante"]);
    expect(saida).toContain("--colunas:2");
    expect(saida).not.toContain("Tradição ortodoxa");
    const blocos = saida.slice(saida.indexOf("data-tradicao"));
    expect(blocos).not.toContain("text-rubric");
  });

  it("sem Divergência não deixa título de seção vazio", () => {
    expect(html(estudo("## O ponto\n\nTexto."))).not.toContain("Divergência entre tradições");
  });
});
