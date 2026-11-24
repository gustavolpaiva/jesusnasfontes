// Validador do gabarito do Assistente (plano 02-23, ASST-12 adiantado): cada regra reprovada tem o seu teste e
// a fixture sintética é o controle positivo. Tudo em memória sobre um acervo sintético em pasta temporária; o
// gabarito de verdade NÃO vive no produto (D-21), e um teste prova que só validador, teste e fixture têm a
// palavra "gabarito" no caminho. A saída nunca carrega texto de pergunta: o marcador da fixture é procurado
// na saída de aprovação e de reprovação.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse as lerYaml } from "yaml";
import {
  type AcervoCarregado,
  carregarAcervo,
  lerArgumentos,
  validarConteudo,
} from "../../../scripts/acervo/validar-gabarito";

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE = path.join(RAIZ, "tests", "fixtures", "acervo", "gabarito-teste.yaml");
const MARCADOR = "MARCADOR-NAO-IMPRIMIR-7f3a";

const temporarios: string[] = [];
afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const sha256 = (t: string) => createHash("sha256").update(t).digest("hex");

type FonteSintetica = { slug: string; publicada: boolean; refs: string[]; comDerivado?: boolean };

/** Pasta temporária com YAMLs de Fonte sintéticos, derivados sintéticos e o lock que os casa. */
function acervoSintetico(fontes: readonly FonteSintetica[]): AcervoCarregado {
  const dir = mkdtempSync(path.join(tmpdir(), "jnf-gabarito-"));
  temporarios.push(dir);
  const pastaFontes = path.join(dir, "fontes");
  const pastaDerivados = path.join(dir, "derivados");
  mkdirSync(pastaFontes);
  mkdirSync(pastaDerivados);
  const lock = {
    orcamento_arquivo_bytes: 1_000_000,
    orcamento_total_bytes: 10_000_000,
    derivados: {} as Record<string, { sha256: string; bytes: number }>,
  };
  for (const f of fontes) {
    writeFileSync(
      path.join(pastaFontes, `${f.slug}.yaml`),
      `slug: ${f.slug}
titulo: Obra sintetica de teste
nivel: primaria
tipo_texto: integral
idioma: en
publicada: ${f.publicada}
licenca: edicao-digital-cc-by-sa-e-traducao-dp
licenca_url: https://creativecommons.org/licenses/by-sa/4.0/
origem_nome: Origem de teste
origem_url: https://origem.exemplo/
tradutor: Tradutor de Teste
traducao_ano: 1900
`,
    );
    if (!f.comDerivado) continue;
    const derivado = JSON.stringify({
      versao_formato: 1,
      slug: f.slug,
      idioma: "en",
      origem_id: "origem-teste",
      origem_sha256: "a".repeat(64),
      gerado_por: "teste",
      secoes: [
        {
          slug: "1",
          titulo: "Secao de teste",
          ordem: 1,
          paragrafos: f.refs.map((r) => ({ ref: r, texto: `Texto sintetico da ref ${r}.` })),
        },
      ],
    });
    writeFileSync(path.join(pastaDerivados, `${f.slug}.json`), derivado);
    lock.derivados[f.slug] = { sha256: sha256(derivado), bytes: Buffer.byteLength(derivado) };
  }
  const arquivoLock = path.join(dir, "lock.json");
  writeFileSync(arquivoLock, JSON.stringify(lock));
  const r = carregarAcervo({ fontes: pastaFontes, derivados: pastaDerivados, lock: arquivoLock });
  if (!r.acervo) throw new Error(`acervo sintético falhou: ${r.erro}`);
  return r.acervo;
}

const ACERVO = () =>
  acervoSintetico([
    { slug: "fonte-exemplo-alfa", publicada: true, refs: ["cap.1", "cap.2"], comDerivado: true },
    { slug: "fonte-exemplo-beta", publicada: true, refs: ["2.10"], comDerivado: true },
    { slug: "fonte-exemplo-gama", publicada: false, refs: [], comDerivado: false },
    { slug: "fonte-exemplo-delta", publicada: true, refs: [], comDerivado: false },
  ]);

const perguntaValida = () => ({
  id: "t-101",
  pergunta: "Pergunta sintetica de teste?",
  tem_resposta: true,
  fontes_esperadas: [{ slug: "fonte-exemplo-alfa", ref: "cap.1" }],
  grupo: "aberto",
  categoria: "factual",
  escrita_em: "2026-11-24",
  escrita_por: "teste",
});

const arquivoValido = () => ({ versao_formato: 1, perguntas: [perguntaValida()] });

type Bruto = ReturnType<typeof arquivoValido>;
type PerguntaBruta = Bruto["perguntas"][number];
const primeira = (bruto: Bruto): PerguntaBruta => bruto.perguntas[0] as PerguntaBruta;
const primeiraFonte = (p: PerguntaBruta) => p.fontes_esperadas[0] as { slug: string; ref: string };

describe("validarGabarito: aprovação e saída sem texto de pergunta", () => {
  it("aprova a fixture sintética contra o acervo de teste, sem REPROVADO e com exit 0", () => {
    const r = validarConteudo(readFileSync(FIXTURE, "utf8"), "gabarito-teste.yaml", ACERVO());
    expect(r.linhas.join("\n")).not.toContain("REPROVADO");
    expect(r.linhas.join("\n")).toContain("4 perguntas lidas");
    expect(r.codigo).toBe(0);
  });

  it("a saída nunca contém o texto de uma pergunta (marcador da fixture), nem ao aprovar nem ao reprovar", () => {
    const aprovado = validarConteudo(
      readFileSync(FIXTURE, "utf8"),
      "gabarito-teste.yaml",
      ACERVO(),
    );
    expect(aprovado.linhas.join("\n")).not.toContain(MARCADOR);
    const comErro = lerYaml(readFileSync(FIXTURE, "utf8")) as { perguntas: unknown[] };
    (comErro.perguntas[2] as { fontes_esperadas: unknown[] }).fontes_esperadas = [
      { slug: "fonte-nunca-vista", ref: "1.1" },
    ];
    const reprovado = validarConteudo(
      JSON.stringify(comErro).replace('"pergunta"', '"pergunta"'),
      "gabarito-teste.yaml",
      ACERVO(),
    );
    expect(reprovado.linhas.join("\n")).toContain("fonte-inexistente");
    expect(reprovado.linhas.join("\n")).not.toContain(MARCADOR);
    expect(reprovado.linhas.join("\n")).not.toContain("jardineiro");
  });

  it("o resumo traz total, sem-resposta, reservadas e categorias, e compara com os pisos sem reprovar", () => {
    const r = validarConteudo(readFileSync(FIXTURE, "utf8"), "gabarito-teste.yaml", ACERVO());
    const saida = r.linhas.join("\n");
    expect(saida).toContain("total=4");
    expect(saida).toContain("sem-resposta=2");
    expect(saida).toContain("reservadas=2 (50%)");
    expect(saida).toContain("factual=1");
    expect(saida).toContain("entre-idiomas=1");
    expect(saida).toContain("fora-do-acervo=1");
    expect(saida).toContain("pessoal-ou-de-fe=1");
    // A fixture tem 4 perguntas: os pisos da Fase 2 (40) aparecem como NÃO, sem mudar o código de saída.
    expect(saida).toContain("total>=40: NÃO");
    expect(r.codigo).toBe(0);
  });
});

describe("validarGabarito: uma reprovação por regra", () => {
  const unicaRegra = (bruto: unknown, regra: string) => {
    const r = validarConteudo(JSON.stringify(bruto), "teste.yaml", ACERVO());
    expect(r.linhas.join("\n")).toContain(regra);
    expect(r.codigo).toBe(1);
    return r.linhas.join("\n");
  };

  it("reprova pergunta vazia (regra pergunta-vazia)", () => {
    const bruto = arquivoValido();
    primeira(bruto).pergunta = "   ";
    unicaRegra(bruto, "pergunta-vazia");
  });

  it("reprova id repetido (regra id-repetido)", () => {
    const bruto = arquivoValido();
    bruto.perguntas.push(perguntaValida());
    unicaRegra(bruto, "id-repetido");
  });

  it("reprova tem_resposta verdadeiro sem fontes (regra resposta-sem-fonte)", () => {
    const bruto = arquivoValido();
    primeira(bruto).fontes_esperadas = [];
    unicaRegra(bruto, "resposta-sem-fonte");
  });

  it("reprova tem_resposta falso com fontes (regra sem-resposta-com-fonte)", () => {
    const bruto = arquivoValido();
    primeira(bruto).tem_resposta = false;
    unicaRegra(bruto, "sem-resposta-com-fonte");
  });

  it("reprova slug que não está no Acervo (regra fonte-inexistente)", () => {
    const bruto = arquivoValido();
    primeiraFonte(primeira(bruto)).slug = "fonte-nunca-vista";
    unicaRegra(bruto, "fonte-inexistente");
  });

  it("reprova Fonte com publicada false (regra fonte-nao-publicada)", () => {
    const bruto = arquivoValido();
    primeiraFonte(primeira(bruto)).slug = "fonte-exemplo-gama";
    unicaRegra(bruto, "fonte-nao-publicada");
  });

  it("reprova Fonte publicada sem derivado no lock (regra derivado-ausente)", () => {
    const bruto = arquivoValido();
    primeiraFonte(primeira(bruto)).slug = "fonte-exemplo-delta";
    unicaRegra(bruto, "derivado-ausente");
  });

  it("reprova referência que não existe no derivado (regra referencia-inexistente)", () => {
    const bruto = arquivoValido();
    primeiraFonte(primeira(bruto)).ref = "9.99";
    unicaRegra(bruto, "referencia-inexistente");
  });

  it("reprova grupo fora da lista (regra grupo-invalido)", () => {
    const bruto = arquivoValido();
    primeira(bruto).grupo = "secreto";
    unicaRegra(bruto, "grupo-invalido");
  });

  it("reprova categoria fora da lista (regra categoria-invalida)", () => {
    const bruto = arquivoValido();
    primeira(bruto).categoria = "livre";
    unicaRegra(bruto, "categoria-invalida");
  });

  it("reprova campo desconhecido e data fora do formato (regra contrato)", () => {
    const bruto = arquivoValido() as unknown as { perguntas: [Record<string, unknown>] };
    bruto.perguntas[0].campo_desconhecido = 1;
    const saida = unicaRegra(bruto, "contrato");
    expect(saida).toContain("campo desconhecido");
    const brutoData = arquivoValido();
    primeira(brutoData).escrita_em = "24-11-2026";
    unicaRegra(brutoData, "contrato");
  });

  it("reprova arquivo sem perguntas e YAML ilegível (regra arquivo)", () => {
    unicaRegra({ versao_formato: 1, perguntas: [] }, "contrato");
    const r = validarConteudo("perguntas: [ {|}", "quebrado.yaml", ACERVO());
    expect(r.linhas.join("\n")).toContain("ilegível");
    expect(r.codigo).toBe(1);
  });
});

describe("validar-gabarito: limites do comando", () => {
  it("sem --arquivo sai 1 com a mensagem de uso, sem imprimir pergunta nenhuma", () => {
    const r = spawnSync(
      path.join(RAIZ, "node_modules", ".bin", "tsx"),
      ["scripts/acervo/validar-gabarito.ts"],
      {
        cwd: RAIZ,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        } as unknown as NodeJS.ProcessEnv,
      },
    );
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toContain("uso:");
  });

  it("lerArgumentos lê --arquivo e as pastas de override; sem --arquivo devolve null", () => {
    const lido = lerArgumentos([
      "--arquivo",
      "/tmp/x.yaml",
      "--fontes",
      "/f",
      "--derivados",
      "/d",
      "--lock",
      "/l",
    ]);
    expect(lido.arquivo).toBe("/tmp/x.yaml");
    expect(lido.opcoes.fontes).toBe("/f");
    expect(lido.opcoes.derivados).toBe("/d");
    expect(lido.opcoes.lock).toBe("/l");
    expect(lerArgumentos(["--fontes", "/f"]).arquivo).toBeNull();
  });

  it("nenhum arquivo de gabarito real está versionado no produto (só validador, teste e fixture sintética)", () => {
    // -co --exclude-standard: também os arquivos ainda não commitados (o teste roda antes do commit da fixture).
    const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
      cwd: RAIZ,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const comGabaritoNoCaminho = r.stdout
      .split("\n")
      .filter((l) => l.trim() !== "" && l.includes("gabarito"))
      .sort();
    expect(comGabaritoNoCaminho).toEqual([
      "scripts/acervo/validar-gabarito.ts",
      "tests/fixtures/acervo/gabarito-teste.yaml",
      "tests/unit/acervo/validar-gabarito.test.ts",
    ]);
  });
});
