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
  const entradas: Record<string, { sha256: string; bytes: number }> = {};
  if (comDerivado) {
    writeFileSync(path.join(raiz, "derivados", "fonte-teste.json"), derivado);
    entradas["fonte-teste"] = {
      sha256: createHash("sha256").update(derivado).digest("hex"),
      bytes: Buffer.byteLength(derivado, "utf8"),
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
