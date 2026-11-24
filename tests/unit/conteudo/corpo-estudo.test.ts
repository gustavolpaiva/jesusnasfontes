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
    // O algarismo vai num span `.algarismos` (fora do versalete), o texto visível é o mesmo.
    expect(saida).toContain('Fonte em preparação · <span class="algarismos">1</span></span>');
    expect(saida).toContain('Fonte em preparação · <span class="algarismos">2</span></span>');
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
    // O Rótulo (versalete e tamanho) não pode se perder na junção das classes.
    expect(chip).toContain("text-label");
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

describe("CorpoEstudo: Citação aprovada (ACER-06, ACER-10, D-10, D-12)", () => {
  const corpo = [
    "## O que acontece",
    "",
    ":afirmacao[Primeira com Citação]{#cit-a1} e :afirmacao[segunda sem]{#cit-a2}.",
    "",
    "## Mais adiante",
    "",
    ":afirmacao[Terceira sem Citação]{#cit-a3}.",
  ].join("\n");
  const citacao = {
    grau: "posicao-majoritaria" as const,
    itens: [
      {
        tipo: "paragrafo" as const,
        id: "c1",
        nivel: "primaria" as const,
        autor: "Autor de Teste",
        obra: "Obra de Teste",
        ref: "1.1",
        trecho: 'Texto com <img src=x onerror="alert(1)"> dentro',
        idioma: "en" as const,
        href: "/acervo/obra-de-teste/1#p-1.1",
      },
    ],
  };
  const afirmacoes = (comCitacao: boolean) => [
    { id: "cit-a1", texto: "Primeira com Citação", ordem: 1, citacao: comCitacao ? citacao : null },
    { id: "cit-a2", texto: "segunda sem", ordem: 2, citacao: null },
    { id: "cit-a3", texto: "Terceira sem Citação", ordem: 3, citacao: null },
  ];

  it("a Afirmação com Citação aprovada troca o chip pelo botão do par de selos; as outras mantêm 'Fonte em preparação'", () => {
    const saida = html(estudo(corpo, { afirmacoes: afirmacoes(true) }));
    // Um botão, fechado, com o nome pelo conteúdo e o ordinal do bloco.
    expect(saida.match(/data-slot="citacao-botao"/g)).toHaveLength(1);
    expect(saida).toContain('aria-expanded="false"');
    expect(saida).toContain("Fonte primária");
    expect(saida).toContain("Posição majoritária");
    expect(saida).toContain(", Grau de certeza: ");
    expect(saida).toContain(". Mostrar a Citação.");
    // O painel só existe aberto: fechado, o trecho de terceiros nem está no HTML.
    expect(saida).not.toContain("citacao-painel");
    expect(saida).not.toContain("onerror");
    // Os dois chips restantes seguem tracejados e inalterados (a segunda do bloco leva o ordinal 2).
    expect(saida.match(/data-slot="chip-fonte"/g)).toHaveLength(2);
    expect(saida).toContain('Fonte em preparação · <span class="algarismos">2</span></span>');
    expect(saida).toContain("border-dashed");
  });

  it("sem Citação aprovada o corpo é o da Fase 1: nenhum botão e nenhum resumo dos selos", () => {
    const saida = html(estudo(corpo, { afirmacoes: afirmacoes(false) }));
    expect(saida).not.toContain("citacao-botao");
    expect(saida).not.toContain("O que são os dois selos?");
    expect(saida.match(/data-slot="chip-fonte"/g)).toHaveLength(3);
  });

  it("o resumo dos dois selos vem uma vez, antes da primeira seção com Citação; o de 'Fonte em preparação' continua", () => {
    const saida = html(estudo(corpo, { afirmacoes: afirmacoes(true) }));
    expect(saida.match(/O que são os dois selos\?/g)).toHaveLength(1);
    expect(saida.match(/O que é “Fonte em preparação”\?/g)).toHaveLength(1);
    expect(saida.indexOf("O que são os dois selos?")).toBeLessThan(
      saida.indexOf("Primeira com Citação"),
    );
  });

  it("o botão fica dentro do parágrafo e só com elementos válidos nele (span e button)", () => {
    const saida = html(estudo(corpo, { afirmacoes: afirmacoes(true) }));
    const paragrafo = /<p class="text-leitura[^"]*">(.*?)<\/p>/s.exec(saida)?.[1] ?? "";
    expect(paragrafo).toContain("citacao-botao");
    expect(paragrafo).not.toMatch(/<(div|p|ul|li|blockquote)[ >]/);
  });

  it("a Afirmação que o Estudo não conhece fica com o chip (id sem Citação)", () => {
    const saida = html(estudo(corpo, { afirmacoes: [] }));
    expect(saida).not.toContain("citacao-botao");
    expect(saida.match(/data-slot="chip-fonte"/g)).toHaveLength(3);
  });
});

describe("CorpoEstudo: capitular", () => {
  const c = (md: string) => html(estudo(md)).includes("first-letter:float-left");
  it("é sempre a letra flutuante, nunca `initial-letter` (que não respeita o clear do chip)", () => {
    expect(html(estudo("## O ponto\n\nJesus é batizado."))).not.toContain("initial-letter");
  });
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

describe("CorpoEstudo: Grau de certeza (TRIL-07)", () => {
  const corpo = "## O ponto\n\nTexto.\n\n## Para hoje\n\nPergunta.";
  const g = (grau: EstudoCompleto["grauDeCerteza"], md = corpo) =>
    html(estudo(md, { grauDeCerteza: grau }));

  it("só aparece com o valor classificado e revisado, antes de 'Para hoje'", () => {
    const saida = g({ valor: "posicao-majoritaria", texto: "Uma explicação.", revisado: true });
    expect(saida).toContain("Grau de certeza");
    expect(saida).toContain("Posição majoritária");
    expect(saida).toContain("Uma explicação.");
    expect(saida.indexOf("Grau de certeza")).toBeLessThan(saida.indexOf("Para hoje"));
    expect(saida.indexOf("Grau de certeza")).toBeGreaterThan(saida.indexOf("Texto."));
  });

  it("os três valores têm a mesma cor e nomes próprios", () => {
    for (const [valor, nome] of [
      ["consenso", "Consenso"],
      ["posicao-majoritaria", "Posição majoritária"],
      ["disputada", "Disputada"],
    ] as const) {
      const saida = g({ valor, texto: null, revisado: true });
      expect(saida).toContain(`>${nome}</p>`);
      expect(saida).toContain("text-rubric");
    }
  });

  it("não aparece sem revisão do dono, mesmo com o valor, nem com o valor nulo", () => {
    expect(g({ valor: "consenso", texto: "x", revisado: false })).not.toContain("Grau de certeza");
    expect(g({ valor: null, texto: "x", revisado: true })).not.toContain("Grau de certeza");
    expect(g({ valor: null, texto: "x", revisado: false })).not.toContain("Grau de certeza");
    expect(g(null)).not.toContain("Grau de certeza");
  });

  it("sem a seção 'Para hoje' vai para o fim do corpo", () => {
    const saida = g({ valor: "disputada", texto: null, revisado: true }, "## O ponto\n\nTexto.");
    expect(saida.indexOf("Grau de certeza")).toBeGreaterThan(saida.indexOf("Texto."));
  });
});
