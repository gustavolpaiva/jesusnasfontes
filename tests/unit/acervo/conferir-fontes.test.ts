// Conferidor dos YAML de Fonte (plano 09, D-18): cada regra reprovada tem o seu teste, e a aprovação é o
// controle positivo. Tudo sobre entradas sintéticas em memória; as regras de arquivo (derivado ausente) usam
// pastas temporárias. O extrato é só leitura: número, título, parágrafos, caracteres e a abertura limitada.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  codigoDeSaidaDaConferencia,
  conferirFonte,
  conferirFontes,
  conferirYaml,
  lerOpcoes,
  nomeiaOEditor,
  tradutorBateComAEvidencia,
  tradutorConfere,
} from "../../../scripts/acervo/conferir-fontes";
import { extratoDaFonte } from "../../../scripts/acervo/extrato-fonte";
import type { Derivado, FonteYaml } from "../../../src/modules/acervo/schemas";

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const CONTEXTO = { tradutores: ["Alice B. Silva", "Bruno C. Souza"] };

const paragrafo = (ref: string, texto: string) => ({ ref, texto });

const derivadoDeTeste = (secoes: Derivado["secoes"]): Derivado => ({
  versao_formato: 1,
  slug: "fonte-teste",
  idioma: "en",
  origem_id: "origem-teste",
  origem_sha256: "a".repeat(64),
  gerado_por: "teste",
  secoes,
});

const RESUMO_VALIDO =
  "Este livro narra a campanha militar e as negociações que a seguiram, do lado do vencedor, com discursos dos chefes.";

const yamlValido = (secoes: string): string => `slug: fonte-teste
titulo: Obra de teste
nivel: primaria
tipo_texto: integral
idioma: en
publicada: true
licenca: edicao-digital-cc-by-sa-e-traducao-dp
licenca_url: https://creativecommons.org/licenses/by-sa/4.0/
origem_nome: Origem de teste
origem_url: https://origem.exemplo/
tradutor: Alice B. Silva e Bruno C. Souza
traducao_ano: 1900
limites_pt: Obra antiga, preservada em cópias medievais.
secoes:
${secoes}`;

const SECOES_VALIDAS = `  - slug: "1"
    titulo: Livro 1
    resumo_pt: ${RESUMO_VALIDO}
    palavras_chave_pt: [guerra, rei, campanha]
  - slug: "2"
    titulo: Livro 2
    resumo_pt: Este livro cobre o reinado seguinte, com a sucessão dos governantes e as revoltas das províncias.
    palavras_chave_pt: [sucessão, revolta, províncias]`;

/** A Fonte válida já interpretada, para os testes que mutam um campo só. */
const fonteValida = (): FonteYaml => {
  return {
    slug: "fonte-teste",
    titulo: "Obra de teste",
    autor: null,
    epoca: null,
    nivel: "primaria",
    tipo_texto: "integral",
    idioma: "en",
    publicada: true,
    licenca: "edicao-digital-cc-by-sa-e-traducao-dp",
    licenca_url: "https://creativecommons.org/licenses/by-sa/4.0/",
    origem_nome: "Origem de teste",
    origem_url: "https://origem.exemplo/",
    tradutor: "Alice B. Silva e Bruno C. Souza",
    traducao_ano: 1900,
    edicao: null,
    traduzida_por_nos: false,
    limites_pt: "Obra antiga, preservada em cópias medievais.",
    secao_max_caracteres: null,
    secoes: [
      {
        slug: "1",
        titulo: "Livro 1",
        resumo_pt: RESUMO_VALIDO,
        palavras_chave_pt: ["guerra", "rei", "campanha"],
      },
      {
        slug: "2",
        titulo: "Livro 2",
        resumo_pt:
          "Este livro cobre o reinado seguinte, com a sucessão dos governantes e as revoltas das províncias.",
        palavras_chave_pt: ["sucessão", "revolta", "províncias"],
      },
    ],
  };
};

const derivadoValido = (): Derivado =>
  derivadoDeTeste([
    {
      slug: "1",
      titulo: "Book 1",
      ordem: 1,
      paragrafos: [
        paragrafo("1.1", "Texto do primeiro parágrafo do livro primeiro da obra de teste."),
      ],
    },
    {
      slug: "2",
      titulo: "Book 2",
      ordem: 2,
      paragrafos: [
        paragrafo("2.1", "Texto do primeiro parágrafo do livro segundo da obra de teste."),
      ],
    },
  ]);

describe("conferirYaml: contrato e aprovação", () => {
  it("aprova o YAML completo e não devolve falha nenhuma", () => {
    expect(
      conferirYaml(yamlValido(SECOES_VALIDAS), "fonte-teste.yaml", {
        ...CONTEXTO,
        derivado: derivadoValido(),
      }),
    ).toEqual([]);
  });

  it("reprova campo desconhecido no YAML (regra contrato)", () => {
    const falhas = conferirYaml(
      `${yamlValido(SECOES_VALIDAS)}\ncampo_desconhecido: 1`,
      "fonte-teste.yaml",
      { ...CONTEXTO, derivado: derivadoValido() },
    );
    expect(falhas.some((f) => f.includes("contrato"))).toBe(true);
  });
});

describe("regras do conferidor", () => {
  it("licença fora do vocabulário reprova (mesmo passando pelo zod de outro caminho)", () => {
    const fonte = fonteValida();
    fonte.licenca = "cc-by-xyz";
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("licenca"))).toBe(true);
  });

  it("tradutor diferente do verificado na origem reprova", () => {
    const fonte = fonteValida();
    fonte.tradutor = "Austin Morris Harmon";
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("tradutor"))).toBe(true);
  });

  it("seção do derivado sem resumo reprova", () => {
    const fonte = fonteValida();
    fonte.secoes = fonte.secoes.slice(0, 1);
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("secao-sem-resumo") && f.includes("2"))).toBe(true);
  });

  it("seção do YAML que não existe no derivado reprova", () => {
    const fonte = fonteValida();
    fonte.secoes[1]?.palavras_chave_pt.push("extra");
    const derivado = derivadoDeTeste([derivadoValido().secoes[0] as Derivado["secoes"][number]]);
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado });
    expect(falhas.some((f) => f.includes("secao-desconhecida") && f.includes("2"))).toBe(true);
  });

  it("dois resumos idênticos na mesma Fonte reproduzem", () => {
    const fonte = fonteValida();
    if (fonte.secoes[1]) fonte.secoes[1].resumo_pt = RESUMO_VALIDO;
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("resumo-duplicado"))).toBe(true);
  });

  it("palavras-chave com menos de 3 termos reprova", () => {
    const fonte = fonteValida();
    if (fonte.secoes[0]) fonte.secoes[0].palavras_chave_pt = ["guerra", "rei"];
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("palavras-chave") && f.includes("menos"))).toBe(true);
  });

  it("palavras-chave com mais de 10 termos reprova", () => {
    const fonte = fonteValida();
    if (fonte.secoes[0])
      fonte.secoes[0].palavras_chave_pt = [
        "a1",
        "a2",
        "a3",
        "a4",
        "a5",
        "a6",
        "a7",
        "a8",
        "a9",
        "a10",
        "a11",
      ];
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("palavras-chave") && f.includes("mais"))).toBe(true);
  });

  it("resumo com menos de 40 caracteres reprova", () => {
    const fonte = fonteValida();
    if (fonte.secoes[0]) fonte.secoes[0].resumo_pt = "Curto demais.";
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("resumo-tamanho") && f.includes("menos"))).toBe(true);
  });

  it("resumo com mais de 700 caracteres reprova", () => {
    const fonte = fonteValida();
    if (fonte.secoes[0]) fonte.secoes[0].resumo_pt = "palavra ".repeat(101);
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.some((f) => f.includes("resumo-tamanho") && f.includes("mais"))).toBe(true);
  });

  it('resumo contendo "<" ou "http" reprova', () => {
    const fonte = fonteValida();
    if (fonte.secoes[0])
      fonte.secoes[0].resumo_pt = "Este livro traz uma genealogia com <marcas> de marcação.";
    if (fonte.secoes[1])
      fonte.secoes[1].resumo_pt = "Este livro cita endereços no formato http de rede externa.";
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() });
    expect(falhas.filter((f) => f.includes("resumo-conteudo"))).toHaveLength(2);
  });

  it("seção acima do teto de caracteres reprova sem exceção registrada", () => {
    const fonte = fonteValida();
    const derivado = derivadoDeTeste([
      {
        slug: "1",
        titulo: "Book 1",
        ordem: 1,
        paragrafos: [paragrafo("1.1", "a".repeat(80_001))],
      },
      derivadoValido().secoes[1] as Derivado["secoes"][number],
    ]);
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado });
    expect(falhas.some((f) => f.includes("teto-de-secao") && f.includes("80.001"))).toBe(true);
  });

  it("a exceção registrada em secao_max_caracteres sustenta a seção acima do teto geral", () => {
    const fonte = fonteValida();
    fonte.secao_max_caracteres = {
      caracteres: 90_000,
      motivo: "a seção é um livro inteiro, página de leitura contínua aceita pelo UI-SPEC",
    };
    const derivado = derivadoDeTeste([
      {
        slug: "1",
        titulo: "Book 1",
        ordem: 1,
        paragrafos: [paragrafo("1.1", "a".repeat(80_001))],
      },
      derivadoValido().secoes[1] as Derivado["secoes"][number],
    ]);
    const falhas = conferirFonte(fonte, { ...CONTEXTO, derivado });
    expect(falhas.some((f) => f.includes("teto-de-secao"))).toBe(false);
  });
});

// Volume editado (CCEL): o cabeçalho só nomeia o EDITOR; quem traduziu cada obra está na introdução da edição.
const SCHAFF = "Schaff, Philip (1819-1893)";
const TRECHO_THELWALL =
  "[Translated by the Rev. S. Thelwall, Late Scholar of Christ’s College, Cantab.]";
const EVIDENCIA_THELWALL = {
  ref: "iv.iii.i-p3",
  tradutores: ["S. Thelwall"],
  trecho: TRECHO_THELWALL,
};
const EVIDENCIA_SCHAFF = {
  ref: "iv.iii.i-p3",
  tradutores: [SCHAFF],
  trecho: "Translated by Philip Schaff, with notes",
};
const VOLUME = {
  tradutores: [],
  editores: [SCHAFF, "Menzies, Allan (1845-1916)"],
  volume: "ccel-anf03",
};

describe("editor não é tradutor (ACER-04)", () => {
  const conferirComTradutor = (
    tradutor: string | null,
    contexto: Parameters<typeof conferirFonte>[1],
  ) => {
    const fonte = fonteValida();
    fonte.tradutor = tradutor;
    fonte.licenca = "dp-declarado-pela-origem";
    return conferirFonte(fonte, contexto).filter((f) => f.startsWith("tradutor"));
  };

  it("tradutor igual ao editor do volume reprova, nomeando a Fonte (pela linha) e o nome", () => {
    const falhas = conferirComTradutor(SCHAFF, {
      ...VOLUME,
      evidenciaTradutor: EVIDENCIA_SCHAFF,
      derivado: derivadoValido(),
    });
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toContain("tradutor-e-editor");
    expect(falhas[0]).toContain(SCHAFF);
    expect(falhas[0]).toContain("ccel-anf03");
  });

  it("o editor reprova mesmo com evidência para OUTRO nome, e em grafia por sobrenome", () => {
    expect(
      conferirComTradutor("Philip Schaff", {
        ...VOLUME,
        evidenciaTradutor: EVIDENCIA_THELWALL,
        derivado: derivadoValido(),
      })[0],
    ).toContain("tradutor-e-editor");
    expect(
      conferirComTradutor("S. Thelwall com Allan Menzies", {
        ...VOLUME,
        evidenciaTradutor: EVIDENCIA_THELWALL,
        derivado: derivadoValido(),
      })[0],
    ).toContain("Menzies");
  });

  it("tradutor com evidência (o da introdução, que não é editor) passa", () => {
    expect(
      conferirComTradutor("S. Thelwall", {
        ...VOLUME,
        evidenciaTradutor: EVIDENCIA_THELWALL,
        derivado: derivadoValido(),
      }),
    ).toEqual([]);
  });

  it("tradutor sem evidência reprova, mesmo não sendo editor", () => {
    const falhas = conferirComTradutor("S. Thelwall", { ...VOLUME, derivado: derivadoValido() });
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toContain("tradutor-sem-evidencia");
    expect(falhas[0]).toContain("S. Thelwall");
  });

  it("Fonte sem tradutor não reprova: o tradutor ausente é o estado honesto", () => {
    expect(conferirComTradutor(null, { ...VOLUME, derivado: derivadoValido() })).toEqual([]);
  });

  it("editor que a evidência mostra ter traduzido a obra passa só quando listado em tradutor_tambem_editor", () => {
    const base = { ...VOLUME, evidenciaTradutor: EVIDENCIA_SCHAFF, derivado: derivadoValido() };
    expect(conferirComTradutor(SCHAFF, { ...base, tradutorTambemEditor: [SCHAFF] })).toEqual([]);
    expect(conferirComTradutor(SCHAFF, { ...base, tradutorTambemEditor: ["Outro"] })[0]).toContain(
      "tradutor-e-editor",
    );
    // sem evidência a exceção não vale
    expect(
      conferirComTradutor(SCHAFF, {
        ...VOLUME,
        tradutorTambemEditor: [SCHAFF],
        derivado: derivadoValido(),
      }).some((f) => f.includes("tradutor-e-editor")),
    ).toBe(true);
  });

  it("a evidência liga o tradutor ao NOME que ela prova: Whiston no Tertuliano reprova mesmo com evidência de Thelwall", () => {
    const falhas = conferirComTradutor("William Whiston", {
      ...VOLUME,
      evidenciaTradutor: EVIDENCIA_THELWALL,
      derivado: derivadoValido(),
    });
    expect(falhas).toHaveLength(1);
    expect(falhas[0]).toContain("tradutor-evidencia");
    expect(falhas[0]).toContain("William Whiston");
    expect(falhas[0]).toContain("S. Thelwall");
    expect(falhas[0]).toContain("iv.iii.i-p3");
    expect(falhas[0]).toContain("Late Scholar");
  });

  it("Thelwall com a evidência certa passa, em qualquer grafia do nome (acento, caixa, ordem, título)", () => {
    for (const tradutor of ["S. Thelwall", "Rev. S. THELWALL", "Thelwáll, S."])
      expect(
        conferirComTradutor(tradutor, {
          ...VOLUME,
          evidenciaTradutor: EVIDENCIA_THELWALL,
          derivado: derivadoValido(),
        }),
      ).toEqual([]);
  });

  it("nome a mais ao lado do tradutor da evidência reprova", () => {
    const falhas = conferirComTradutor("S. Thelwall e William Whiston", {
      ...VOLUME,
      evidenciaTradutor: EVIDENCIA_THELWALL,
      derivado: derivadoValido(),
    });
    expect(falhas[0]).toContain("tradutor-evidencia");
  });

  it("o trecho do registro tem de nomear o tradutor esperado", () => {
    const falhas = conferirComTradutor("S. Thelwall", {
      ...VOLUME,
      evidenciaTradutor: { ...EVIDENCIA_THELWALL, trecho: "[Translated by the Rev. J. Smith]" },
      derivado: derivadoValido(),
    });
    expect(falhas.some((f) => f.includes("não nomeia") && f.includes("S. Thelwall"))).toBe(true);
  });

  describe("o parágrafo de evidência no derivado versionado", () => {
    const derivadoComIntro = (texto: string) =>
      derivadoDeTeste([
        {
          slug: "iv-iii",
          titulo: "Apology",
          ordem: 1,
          paragrafos: [paragrafo("iv.iii.i-p3", texto), paragrafo("iv.iii.i-p4", "Corpo da obra.")],
        },
      ]);
    const contexto = (derivado: Derivado, divisoes: string[] = ["iv.iii"]) => ({
      ...VOLUME,
      evidenciaTradutor: EVIDENCIA_THELWALL,
      divisoesDoArquivo: divisoes,
      derivado,
    });

    it("o parágrafo existe e traz o trecho: passa", () => {
      expect(
        conferirComTradutor("S. Thelwall", contexto(derivadoComIntro(TRECHO_THELWALL))),
      ).toEqual([]);
    });

    it("referência que não existe numa divisão da própria Fonte reprova", () => {
      const sem = derivadoDeTeste([
        {
          slug: "iv-iii",
          titulo: "Apology",
          ordem: 1,
          paragrafos: [paragrafo("iv.iii.i-p4", "Corpo da obra.")],
        },
      ]);
      const falhas = conferirComTradutor("S. Thelwall", contexto(sem));
      expect(falhas).toHaveLength(1);
      expect(falhas[0]).toContain("iv.iii.i-p3");
      expect(falhas[0]).toContain("não existe");
    });

    it("parágrafo que existe mas diz outra coisa reprova, citando o que ele diz", () => {
      const falhas = conferirComTradutor(
        "S. Thelwall",
        contexto(derivadoComIntro("[Edited by the Rev. J. Smith, Cantab.]")),
      );
      expect(falhas).toHaveLength(1);
      expect(falhas[0]).toContain("não contém o trecho");
      expect(falhas[0]).toContain("Edited by the Rev. J. Smith");
    });

    it("evidência fora das divisões da Fonte (introdução do volume) vale pelo trecho fixado: o verify a prova no bruto", () => {
      const fora = { ...EVIDENCIA_THELWALL, ref: "iv.i-p2" };
      expect(
        conferirComTradutor("S. Thelwall", {
          ...contexto(derivadoComIntro(TRECHO_THELWALL)),
          evidenciaTradutor: fora,
        }),
      ).toEqual([]);
    });
  });

  it("tradutor verificado no cabeçalho (origem TEI) dispensa a evidência de introdução", () => {
    const fonte = fonteValida();
    expect(
      conferirFonte(fonte, { ...CONTEXTO, derivado: derivadoValido() }).filter((f) =>
        f.startsWith("tradutor"),
      ),
    ).toEqual([]);
  });

  it("NPNF2-01: McGiffert, que o cabeçalho marca como Translator, passa sem evidência de introdução; com o editor junto reprova", () => {
    const npnf = {
      tradutores: ["McGiffert, Rev. Arthur Cushman, Ph.D."],
      editores: [SCHAFF],
      volume: "ccel-npnf201",
      derivado: derivadoValido(),
    };
    expect(conferirComTradutor("McGiffert, Rev. Arthur Cushman, Ph.D.", npnf)).toEqual([]);
    const falhas = conferirComTradutor(`McGiffert, Rev. Arthur Cushman, Ph.D. com ${SCHAFF}`, npnf);
    expect(falhas.some((f) => f.startsWith("tradutor-e-editor"))).toBe(true);
  });

  it("nomeiaOEditor casa pelo nome inteiro ou pelo sobrenome como palavra, sem acento nem caixa", () => {
    expect(nomeiaOEditor("Schaff, Philip (1819-1893) e Menzies, Allan", SCHAFF)).toBe(true);
    expect(nomeiaOEditor("P. SCHAFF", SCHAFF)).toBe(true);
    expect(nomeiaOEditor("Alexander Roberts", "Roberts, Alexander (1826-1901)")).toBe(true);
    expect(nomeiaOEditor("S. Thelwall", SCHAFF)).toBe(false);
    expect(nomeiaOEditor("Schaffner", SCHAFF)).toBe(false);
  });
});

// Uma normalização para todo lado de toda comparação (YAML, nome esperado, frase da evidência, conectivos): cada nome
// esperado vale em TODAS as variantes de grafia que o conteúdo pode trazer.
describe("variantes de nome: o tradutor certo nunca é reprovado pela grafia", () => {
  const PAPEIS = [
    "",
    "Tradução de ",
    "Traduzido por ",
    "TRADUÇÃO DE ",
    "tr. ",
    "Trad. ",
    "Translated by ",
  ];
  const NOMES: { esperado: string; variantes: string[] }[] = [
    {
      esperado: "S. Thelwall",
      variantes: [
        "S. Thelwall",
        "Thelwall, S.",
        "S.Thelwall",
        "s. THELWALL",
        "S. Thelwáll",
        "Rev. S. Thelwall",
      ],
    },
    {
      esperado: "Giovanni Battista de Rossi",
      variantes: [
        "Giovanni Battista de Rossi",
        "De Rossi, Giovanni Battista",
        "G. B. De Rossi",
        "Rossi, Giovanni Battista de",
        "giovanni battista DE ROSSI",
      ],
    },
    {
      esperado: "De Rossi, Giovanni Battista",
      variantes: ["De Rossi, Giovanni Battista", "Giovanni Battista de Rossi", "G. B. de Rossi"],
    },
    {
      esperado: "Adolf von Harnack",
      variantes: [
        "Adolf von Harnack",
        "Von Harnack, Adolf",
        "A. von Harnack",
        "Harnack, Adolf von",
      ],
    },
    {
      esperado: "Jan van der Meer",
      variantes: ["Jan van der Meer", "Van der Meer, Jan", "J. van der Meer"],
    },
    {
      esperado: "João da Silva",
      variantes: ["João da Silva", "Silva, João da", "Joao da Silva", "Da Silva, João"],
    },
  ];

  for (const { esperado, variantes } of NOMES)
    for (const papel of PAPEIS)
      for (const variante of variantes) {
        const valor = `${papel}${variante}`;
        it(`"${valor}" é o tradutor esperado "${esperado}"`, () => {
          expect(tradutorBateComAEvidencia(valor, [esperado])).toBe(true);
          // a frase da evidência, na mesma grafia, também nomeia o esperado
          const falhas = conferirFonte(
            { ...fonteValida(), tradutor: valor, licenca: "dp-declarado-pela-origem" },
            {
              tradutores: [],
              editores: [],
              evidenciaTradutor: {
                ref: "x-p1",
                tradutores: [esperado],
                trecho: `[${papel}${variante}, late of the College]`,
              },
              derivado: derivadoValido(),
            },
          );
          expect(falhas.filter((f) => f.startsWith("tradutor"))).toEqual([]);
        });
      }

  it("o nome errado continua reprovando em toda variante: Whiston no lugar de Thelwall, e nome a mais", () => {
    for (const papel of PAPEIS) {
      expect(tradutorBateComAEvidencia(`${papel}William Whiston`, ["S. Thelwall"])).toBe(false);
      expect(
        tradutorBateComAEvidencia(`${papel}S. Thelwall e William Whiston`, ["S. Thelwall"]),
      ).toBe(false);
      // "Rossi" sozinho não é "de Rossi": o sobrenome composto vale como sequência. (Ambiguidade que a gramática não
      // desfaz: em "Tradução de Rossi" o "de" do papel também lê "de Rossi"; por isso o papel "… de" fica de fora aqui.)
      if (!papel.trim().toLowerCase().endsWith("de"))
        expect(
          tradutorBateComAEvidencia(`${papel}Rossi, Giovanni Battista`, [
            "Giovanni Battista de Rossi",
          ]),
        ).toBe(false);
      expect(
        tradutorBateComAEvidencia(`${papel}Giulio Rossi Mancini`, ["Giovanni Battista de Rossi"]),
      ).toBe(false);
    }
  });

  it("o trecho da evidência que não nomeia o sobrenome composto inteiro reprova", () => {
    const falhas = conferirFonte(
      {
        ...fonteValida(),
        tradutor: "De Rossi, Giovanni Battista",
        licenca: "dp-declarado-pela-origem",
      },
      {
        tradutores: [],
        evidenciaTradutor: {
          ref: "x-p1",
          tradutores: ["Giovanni Battista de Rossi"],
          trecho: "[Translated by De Rossi, Esq.]",
        },
        derivado: derivadoValido(),
      },
    );
    expect(falhas.some((f) => f.includes("não nomeia"))).toBe(false); // o sobrenome composto aparece inteiro
    const sem = conferirFonte(
      {
        ...fonteValida(),
        tradutor: "De Rossi, Giovanni Battista",
        licenca: "dp-declarado-pela-origem",
      },
      {
        tradutores: [],
        evidenciaTradutor: {
          ref: "x-p1",
          tradutores: ["Giovanni Battista de Rossi"],
          trecho: "[Translated by Giovanni Battista Rossi]",
        },
        derivado: derivadoValido(),
      },
    );
    expect(sem.some((f) => f.includes("não nomeia"))).toBe(true);
  });

  it("tradutor provado no cabeçalho também passa em toda grafia de papel e acento", () => {
    for (const papel of PAPEIS) {
      expect(tradutorConfere(`${papel}Alice B. Silva`, ["Alice B. Silva"])).toBe(true);
      expect(tradutorConfere(`${papel}SILVA, Alice B.`, ["Alice B. Silva"])).toBe(false); // nome inteiro: ordem do cabeçalho
    }
    expect(tradutorConfere("Tradução de Álice B. Silva", ["Alice B. Silva"])).toBe(true);
  });
});

describe("conferirFontes (arquivos): editor e evidência vêm do registro", () => {
  const rodar = (mexer: (o: Record<string, unknown>) => void) => {
    const raiz = pastaDeConferencia(true);
    const caminho = path.join(raiz, "origens.yaml");
    const origem = JSON.parse(JSON.stringify(ORIGEM_DE_TESTE)) as Record<string, unknown>;
    mexer(origem);
    writeFileSync(
      caminho,
      `origem-teste:\n${JSON.stringify(origem, null, 2)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}\n`,
    );
    return conferirFontes(["fonte-teste"], {
      fontes: path.join(raiz, "fontes"),
      derivados: path.join(raiz, "derivados"),
      lock: path.join(raiz, "derivados.lock.json"),
      origens: caminho,
    });
  };
  const comoThml = (o: Record<string, unknown>) => {
    o.formato = "thml";
    o.verificador = { editores: ["Prado, Eva"], licenca: "Public Domain" };
  };
  const comEvidencia = (o: Record<string, unknown>) => {
    const a = arquivo(o);
    a.evidencia_tradutor = "iv.iii-p1";
    a.tradutor_esperado = ["Alice B. Silva", "Bruno C. Souza"];
    a.evidencia_trecho = "Translated by Alice B. Silva and Bruno C. Souza";
  };
  const arquivo = (o: Record<string, unknown>) =>
    (o.arquivos as Record<string, unknown>[])[0] ?? {};

  it("volume ThML: tradutor sem evidencia_tradutor no registro reprova com código 1", () => {
    const r = rodar(comoThml);
    expect(r.codigo).toBe(1);
    expect(
      r.linhas.some((l) => l.startsWith("REPROVADO fonte-teste: tradutor-sem-evidencia")),
    ).toBe(true);
  });

  it("volume ThML: com evidencia_tradutor, e o tradutor não sendo o editor, a Fonte passa", () => {
    const r = rodar((o) => {
      comoThml(o);
      comEvidencia(o);
    });
    expect(r.linhas).toContain("OK fonte-teste");
    expect(r.codigo).toBe(0);
  });

  it("volume ThML: o editor do registro no campo tradutor reprova mesmo com evidência", () => {
    const r = rodar((o) => {
      comoThml(o);
      comEvidencia(o);
      (o.verificador as Record<string, unknown>).editores = ["Souza, Bruno C."];
    });
    expect(r.codigo).toBe(1);
    expect(
      r.linhas.some((l) => l.includes("tradutor-e-editor") && l.includes("Souza, Bruno C.")),
    ).toBe(true);
  });
});

describe("tradutorConfere", () => {
  it("casa os nomes esperados com pontuação e espaço variáveis", () => {
    expect(tradutorConfere("F. C. T. Bosanquet", ["F.C.T. Bosanquet"])).toBe(true);
    expect(
      tradutorConfere("William Melmoth, com revisão de F. C. T. Bosanquet", [
        "William Melmoth",
        "F. C. T. Bosanquet",
      ]),
    ).toBe(true);
    expect(tradutorConfere("Alice B. Silva e Bruno C. Souza", CONTEXTO.tradutores)).toBe(true);
  });

  it("reprova nome que a origem não verificou e texto que sobra além dos nomes", () => {
    expect(tradutorConfere("Austin Morris Harmon", CONTEXTO.tradutores)).toBe(false);
    expect(
      tradutorConfere(
        "Alice B. Silva, Bruno C. Souza e Tradutor Desconhecido",
        CONTEXTO.tradutores,
      ),
    ).toBe(false);
    expect(tradutorConfere("Alice B. Silva com nota do editor", CONTEXTO.tradutores)).toBe(false);
  });
});

describe("extratoDaFonte", () => {
  it("devolve número, título, parágrafos, caracteres e a abertura limitada a 500", () => {
    const derivado = derivadoDeTeste([
      {
        slug: "1",
        titulo: "Book 1",
        ordem: 1,
        paragrafos: [paragrafo("1.1", `${"x".repeat(600)}`)],
      },
    ]);
    const titulos = new Map([["1", "Livro 1"]]);
    const [extrato] = extratoDaFonte(derivado, titulos);
    expect(extrato).toBeDefined();
    expect(extrato?.numero).toBe(1);
    expect(extrato?.titulo).toBe("Livro 1");
    expect(extrato?.paragrafos).toBe(1);
    expect(extrato?.caracteres).toBe(600);
    expect(extrato?.abertura.length).toBe(500);
  });
});

// ───────────────────────── nível de arquivo: pastas temporárias ─────────────────────────

const ORIGEM_DE_TESTE = {
  nome: "Origem de teste",
  autores: ["Origem"],
  licenca: "CC BY-SA",
  url_licenca: "https://creativecommons.org/licenses/by-sa/4.0/",
  fonte: "https://origem.exemplo/",
  commit: "abcdef1234567890abcdef1234567890abcdef1234",
  data_versao: "2026-11-24",
  alteracoes: "Nenhuma.",
  formato: "tei",
  publicavel: true,
  motivo: "teste",
  arquivos: [
    {
      id: "obra.xml",
      url: "https://origem.exemplo/obra.xml",
      slug: "fonte-teste",
      idioma: "en",
    },
  ],
  verificador: { tradutores: ["Alice B. Silva", "Bruno C. Souza"], licenca: "CC BY-SA" },
  esperado: { secoes: 1, paragrafos: [], notas_fora_do_texto: true },
} as const;

function pastaDeConferencia(comDerivado: boolean): string {
  const raiz = mkdtempSync(path.join(tmpdir(), "jnf-conferir-"));
  temporarios.push(raiz);
  mkdirSync(path.join(raiz, "fontes"));
  mkdirSync(path.join(raiz, "derivados"));
  writeFileSync(path.join(raiz, "fontes", "fonte-teste.yaml"), yamlValido(SECOES_VALIDAS));
  const derivado = JSON.stringify(derivadoValido(), null, 2);
  const entradas: Record<string, { sha256: string; bytes: number; revisao: number }> = {};
  if (comDerivado) {
    writeFileSync(path.join(raiz, "derivados", "fonte-teste.json"), derivado);
    entradas["fonte-teste"] = {
      sha256: createHash("sha256").update(derivado).digest("hex"),
      bytes: Buffer.byteLength(derivado, "utf8"),
      revisao: 1,
    };
  }
  writeFileSync(
    path.join(raiz, "derivados.lock.json"),
    `${JSON.stringify(
      {
        orcamento_arquivo_bytes: 8_388_608,
        orcamento_total_bytes: 31_457_280,
        derivados: entradas,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    path.join(raiz, "origens.yaml"),
    `origem-teste:\n${JSON.stringify(ORIGEM_DE_TESTE, null, 2)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")}\n`,
  );
  return raiz;
}

describe("lerOpcoes", () => {
  it("consome cada flag com o seu valor antes de colher os slugs posicionais", () => {
    const { slugs, opcoes } = lerOpcoes(["--fontes", "content/acervo/fontes", "luciano-peregrino"]);
    expect(slugs).toEqual(["luciano-peregrino"]);
    expect(opcoes.fontes).toBe(path.resolve("content/acervo/fontes"));
  });

  it("sem slug explícito, o valor de --fontes não vira slug e a pasta toda é conferida", () => {
    const { slugs, opcoes } = lerOpcoes(["--fontes", "content/acervo/fontes"]);
    expect(slugs).toEqual([]);
    expect(opcoes.fontes).toBe(path.resolve("content/acervo/fontes"));
  });
});

describe("conferirFontes (arquivos)", () => {
  it("imprime OK e sai 0 com YAML, derivado e lock coerentes", () => {
    const raiz = pastaDeConferencia(true);
    const r = conferirFontes(["fonte-teste"], {
      fontes: path.join(raiz, "fontes"),
      derivados: path.join(raiz, "derivados"),
      lock: path.join(raiz, "derivados.lock.json"),
      origens: path.join(raiz, "origens.yaml"),
    });
    expect(r.linhas).toContain("OK fonte-teste");
    expect(r.codigo).toBe(0);
    expect(codigoDeSaidaDaConferencia(r)).toBe(0);
  });

  it("Fonte publicada sem derivado reprova com código 2", () => {
    const raiz = pastaDeConferencia(false);
    const r = conferirFontes(undefined, {
      fontes: path.join(raiz, "fontes"),
      derivados: path.join(raiz, "derivados"),
      lock: path.join(raiz, "derivados.lock.json"),
      origens: path.join(raiz, "origens.yaml"),
    });
    expect(
      r.linhas.some(
        (l) => l.startsWith("REPROVADO fonte-teste:") && l.includes("derivado-ausente"),
      ),
    ).toBe(true);
    expect(r.codigo).toBe(2);
  });
});
