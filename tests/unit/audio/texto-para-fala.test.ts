import { describe, expect, it } from "vitest";
import {
  type EstudoFalavel,
  estudoParaFala,
  passagemParaFala,
  referenciasPorExtenso,
  versiculoParaFala,
} from "@/modules/audio/texto-para-fala";

function estudo(parte: Partial<EstudoFalavel> = {}): EstudoFalavel {
  return {
    titulo: "Batismo e tentação",
    trilha: { id: "pontos-centrais", nome: "Pontos centrais", ordem: 2 },
    corpoMd: "## O que acontece\n\nTexto.",
    grauDeCerteza: null,
    passagens: [],
    divergencias: [],
    perguntas: [],
    ...parte,
  };
}

describe("referenciasPorExtenso", () => {
  it('"Mt 3:13-17" vira "Mateus, capítulo 3, versículos 13 a 17"', () => {
    expect(referenciasPorExtenso("Leia Mt 3:13-17 hoje.")).toBe(
      "Leia Mateus, capítulo 3, versículos 13 a 17 hoje.",
    );
  });

  it("versículo único, capítulo inteiro e intervalo entre capítulos", () => {
    expect(referenciasPorExtenso("Jo 3:16")).toBe("João, capítulo 3, versículo 16");
    expect(referenciasPorExtenso("veja Sl 23")).toBe("veja Salmos, capítulo 23");
    expect(referenciasPorExtenso("Mt 3:13 a 4:11")).toBe(
      "Mateus, capítulo 3, versículo 13 a capítulo 4, versículo 11",
    );
    expect(referenciasPorExtenso("1 Co 13")).toBe("1 Coríntios, capítulo 13");
  });

  it("palavra comum seguida de número não vira referência", () => {
    for (const frase of [
      "Os 3 pilares",
      "Em 2026 tudo mudou",
      "Capítulo 3 é longo",
      "Cerca de 40 dias",
    ]) {
      expect(referenciasPorExtenso(frase), frase).toBe(frase);
    }
  });
});

describe("estudoParaFala", () => {
  it("lê o título, a leitura bíblica e as seções na ordem, com o título de cada seção", () => {
    const fala = estudoParaFala(
      estudo({
        passagens: [{ inicio: 40003013, fim: 40003017, ordem: 1, referenciaTexto: "Mt 3:13-17" }],
        corpoMd:
          "## O que acontece\n\nJesus vai ao Jordão.\n\n## Pontos centrais\n\n- Primeiro ponto\n- Segundo ponto\n\n## Para hoje\n\nQual é a sua tentação?",
      }),
    );
    expect(fala.split("\n\n")).toEqual([
      "Batismo e tentação.",
      "Leitura bíblica: Mateus, capítulo 3, versículos 13 a 17.",
      "O que acontece.",
      "Jesus vai ao Jordão.",
      "Pontos centrais.",
      "Primeiro ponto.",
      "Segundo ponto.",
      "Para hoje.",
      "Qual é a sua tentação?",
    ]);
  });

  it("a Afirmação é lida como texto comum: sem chip, sem ordinal, sem o resumo, sem a diretiva", () => {
    const fala = estudoParaFala(
      estudo({
        corpoMd:
          "## O que acontece\n\n:afirmacao[Jesus é batizado por João no Jordão]{#pc03-a1} e ouve a voz do Pai. Depois :afirmacao[passa quarenta dias no deserto]{#pc03-a2}.\n\n- :afirmacao[Item com fato]{#pc03-a3}",
      }),
    );
    expect(fala).toContain("Jesus é batizado por João no Jordão e ouve a voz do Pai.");
    expect(fala).toContain("Depois passa quarenta dias no deserto.");
    expect(fala).toContain("Item com fato.");
    for (const proibido of ["Fonte em preparação", "afirmacao", "pc03", "{#", ":afirmacao", "["]) {
      expect(fala, proibido).not.toContain(proibido);
    }
  });

  it("a Afirmação com Citação aprovada é falada igual à sem Citação: nenhum selo, grau, painel ou botão entra na fala (ACER-06)", () => {
    const corpoMd =
      "## O que acontece\n\n:afirmacao[Jesus é batizado por João no Jordão]{#pc03-a1} e ouve a voz do Pai.\n\n- :afirmacao[Item com fato]{#pc03-a3}";
    const semCitacao = estudoParaFala(estudo({ corpoMd }));
    // O Estudo completo traz as Citações aprovadas por Afirmação; a fala só recebe o Markdown de origem.
    const comCitacao = estudoParaFala({
      ...estudo({ corpoMd }),
      afirmacoes: [
        {
          id: "pc03-a1",
          citacao: {
            grau: "consenso",
            itens: [
              {
                tipo: "passagem",
                id: "c1",
                nivel: "primaria",
                referencia: "Lucas 2:7",
                edicao: "n4",
                versiculos: [{ numero: 7, texto: "Texto da Passagem citada." }],
                inicio: 42002007,
                fim: 42002007,
              },
            ],
          },
        },
      ],
    } as EstudoFalavel);
    expect(comCitacao).toBe(semCitacao);
    for (const proibido of [
      "Fonte primária",
      "Pesquisa acadêmica",
      "Consenso",
      "Grau de certeza",
      "Mostrar a Citação",
      "Texto da Passagem citada",
      "O que são os dois selos",
    ]) {
      expect(comCitacao, proibido).not.toContain(proibido);
    }
  });

  it("não lê rótulos de interface: eyebrow, meta, botões, volta, Sessão", () => {
    const fala = estudoParaFala(estudo(), { volta: 3 });
    for (const rotulo of [
      "Base histórica",
      "estudo 2 de",
      "cerca de",
      "minutos",
      "Ouvir",
      "Pausar",
      "Marcar como concluído",
      "volta 3",
      "Sessão",
      "Recolher",
      "Minha anotação",
    ]) {
      expect(fala, rotulo).not.toContain(rotulo);
    }
  });

  it("a referência dentro do texto vira fala por extenso, sem restar a forma escrita", () => {
    const fala = estudoParaFala(
      estudo({ corpoMd: "## O que acontece\n\nLeia também Mt 1:18-25 se sobrar tempo." }),
    );
    expect(fala).toContain("Leia também Mateus, capítulo 1, versículos 18 a 25 se sobrar tempo.");
    expect(fala).not.toContain("Mt 1:18");
  });

  it('o ":13" de "Mt 3:13" no meio de uma frase com Afirmação não se perde', () => {
    const fala = estudoParaFala(
      estudo({ corpoMd: "## O ponto\n\n:afirmacao[Em Mt 3:13 Jesus vai ao Jordão]{#bh01-a1}." }),
    );
    expect(fala).toContain("Em Mateus, capítulo 3, versículo 13 Jesus vai ao Jordão.");
  });

  it("negrito, itálico, citação e « » ficam só como texto", () => {
    const fala = estudoParaFala(
      estudo({
        corpoMd: "## Palavra central (paráfrase)\n\n> Não se vive **só** de *pão* «talvez».",
      }),
    );
    expect(fala).toContain("Não se vive só de pão talvez.");
    expect(fala).not.toMatch(/[*«»>]/);
  });

  it("Grau de certeza: só com valor revisado, antes de 'Para hoje'", () => {
    const base = {
      corpoMd: "## O ponto\n\nA.\n\n## Para hoje\n\nB.",
    };
    const revisado = estudoParaFala(
      estudo({
        ...base,
        grauDeCerteza: { valor: "consenso", texto: "Quase todos concordam.", revisado: true },
      }),
    ).split("\n\n");
    expect(revisado.indexOf("Grau de certeza: Consenso.")).toBeGreaterThan(0);
    expect(revisado.indexOf("Grau de certeza: Consenso.")).toBeLessThan(
      revisado.indexOf("Para hoje."),
    );
    expect(revisado).toContain("Quase todos concordam.");
    const naoRevisado = estudoParaFala(
      estudo({ ...base, grauDeCerteza: { valor: "consenso", texto: "x", revisado: false } }),
    );
    expect(naoRevisado).not.toContain("Grau de certeza");
  });

  it("Divergência na ordem das leituras dadas, com a introdução fixa e sem rótulo de interface", () => {
    const fala = estudoParaFala(
      estudo({
        divergencias: [
          {
            tema: "O batismo",
            leituras: [
              { tradicao: "catolica", resumo: "Leitura A." },
              { tradicao: "ortodoxa", resumo: "Leitura B." },
              { tradicao: "protestante", resumo: "Leitura C." },
            ],
          },
        ],
      }),
    );
    const blocos = fala.split("\n\n");
    const i = blocos.indexOf("Divergência entre tradições.");
    expect(blocos.slice(i, i + 9)).toEqual([
      "Divergência entre tradições.",
      "Cristãos de tradições diferentes leem este ponto de formas diferentes. Mostramos cada leitura, sem escolher uma.",
      "O batismo.",
      "Tradição católica.",
      "Leitura A.",
      "Tradição ortodoxa.",
      "Leitura B.",
      "Tradição protestante.",
      "Leitura C.",
    ]);
  });

  it("Leitura contínua: as três perguntas do conjunto da volta, sem o rótulo 'volta N'", () => {
    const perguntas = [
      ["A1?", "A2?", "A3?"],
      ["B1?", "B2?", "B3?"],
      ["C1?", "C2?", "C3?"],
    ];
    const base = estudo({
      trilha: { id: "leitura-continua", nome: "Leitura contínua", ordem: 3 },
      perguntas,
    });
    expect(estudoParaFala(base, { volta: 1 })).toContain(
      "Três perguntas para responder.\n\nA1?\n\nA2?\n\nA3?",
    );
    expect(estudoParaFala(base, { volta: 2 })).toContain("B1?\n\nB2?\n\nB3?");
    expect(estudoParaFala(base, { volta: 4 })).toContain("A1?");
    expect(estudoParaFala(base, { volta: 2 })).not.toContain("volta");
    // Fora da Leitura contínua, nada de perguntas.
    expect(estudoParaFala(estudo({ perguntas }))).not.toContain("Três perguntas");
  });

  it("referência bíblica que o interpretador não entende não derruba a leitura", () => {
    const fala = estudoParaFala(
      estudo({
        passagens: [{ inicio: 1, fim: 2, ordem: 1, referenciaTexto: "isto não é referência" }],
      }),
    );
    expect(fala).toContain("Batismo e tentação.");
    expect(fala).not.toContain("Leitura bíblica");
  });
});

describe("passagemParaFala", () => {
  const trecho = {
    referenciaFalada: "Mateus, capítulo 3, versículos 13 a 15",
    capitulos: [
      {
        subtitulo: null,
        versiculos: [
          { conteudo: "Então veio Jesus da Galileia ao Jordão," },
          { conteudo: "«e disse:» Permite agora, porque assim nos convém.[a]" },
          { conteudo: "Então ele o permitiu.*" },
        ],
      },
    ],
  };

  it("texto corrido: referência falada, sem números de versículo, sem « » e sem marcas de nota", () => {
    const fala = passagemParaFala([trecho]);
    expect(fala.split("\n\n")).toEqual([
      "Mateus, capítulo 3, versículos 13 a 15.",
      "Então veio Jesus da Galileia ao Jordão, e disse: Permite agora, porque assim nos convém. Então ele o permitiu.",
    ]);
    expect(fala).not.toMatch(/[«»*†]|\[a\]/);
    expect(fala).not.toMatch(/\b13\b.*\bEntão veio/);
  });

  it("o subtítulo de capítulo vira 'Livro, capítulo N' e o número do verso nunca entra", () => {
    const fala = passagemParaFala([
      {
        referenciaFalada: "Mateus, capítulo 3, versículo 13 a capítulo 4, versículo 11",
        capitulos: [
          { subtitulo: "Mateus 3", versiculos: [{ conteudo: "Texto um." }] },
          { subtitulo: "Mateus 4", versiculos: [{ conteudo: "Texto dois." }] },
        ],
      },
    ]);
    expect(fala).toContain("Mateus, capítulo 3.");
    expect(fala).toContain("Mateus, capítulo 4.");
    expect(fala).not.toMatch(/\d+ Texto/);
  });

  it("versiculoParaFala tira « », marcas de nota e espaço antes da pontuação", () => {
    expect(versiculoParaFala("«Disse»¹ ele † , calou [1] .")).toBe("Disse ele, calou.");
  });

  it("sem versículos, sem texto", () => {
    expect(passagemParaFala([])).toBe("");
  });
});
