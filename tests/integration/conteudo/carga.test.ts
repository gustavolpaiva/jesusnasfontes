import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { ErroDeBanco } from "@/db/erro-banco";
import { lerEstudoPorSlug } from "@/modules/conteudo/estudo";
import { lerPassagem } from "@/modules/texto";
import { carregarConteudo, PASTA_PADRAO } from "../../../scripts/content/carregar";
import { ErroConteudo, lerPasta } from "../../../scripts/content/esquema";
import { aplicarEnvDeTeste, semearTexto } from "../../support/preparar-banco";

// Um Estudo real de content/ faz o caminho arquivo, banco e leitura; a Passagem dele é lida por
// intervalo de chave. A carga é idempotente e atômica.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const emNeon = () => inject("alvoBanco") === "neon";
const temporarios: string[] = [];

async function contar(sql: string, params: unknown[] = []): Promise<number> {
  const r = await obterPool().query<{ n: number }>(sql, params);
  return r.rows[0]?.n ?? -1;
}

function pastaTemporaria(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jnf-conteudo-"));
  temporarios.push(dir);
  mkdirSync(path.join(dir, "trilhas", "pontos-centrais"), { recursive: true });
  writeFileSync(
    path.join(dir, "trilhas", "trilhas.yaml"),
    [
      "- { id: pontos-centrais, nome: Pontos centrais, ordem: 2, descricao: Teste }",
      "- { id: base-historica, nome: Base histórica, ordem: 1, descricao: Teste }",
      "",
    ].join("\n"),
  );
  return dir;
}

function estudoMd(slug: string, ordem: number, leitura: string[]): string {
  return [
    "---",
    `slug: ${slug}`,
    "trilha: pontos-centrais",
    `ordem: ${ordem}`,
    `titulo: Estudo de teste ${ordem}`,
    "recorte: historico",
    `leitura: ${JSON.stringify(leitura)}`,
    "---",
    "",
    "## O que acontece",
    "",
    "Texto de teste.",
    "",
  ].join("\n");
}

// O conteúdo real cita os quatro evangelhos e 1 Coríntios: sem esses livros no banco, a carga de
// content/ falha pela chave estrangeira da Passagem (23503).
async function carregarLivrosDoConteudo(): Promise<void> {
  await semearTexto({ livros: [40, 41, 42, 43, 46] });
}

beforeAll(async () => {
  aplicarEnvDeTeste();
  await carregarLivrosDoConteudo();
});
afterAll(async () => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
  await obterPool().end();
});

describe("content:load com o Estudo real batismo-e-tentacao", () => {
  it("carrega, a segunda carga não muda nada e o Estudo volta pelo slug", async () => {
    const conteudo = await lerPasta(PASTA_PADRAO);
    expect(conteudo.estudos.map((e) => e.frontMatter.slug)).toContain("batismo-e-tentacao");
    expect(conteudo.trilhas.map((t) => t.id).sort()).toEqual([
      "base-historica",
      "leitura-continua",
      "pontos-centrais",
    ]);

    const primeira = await carregarConteudo(conteudo);
    expect(
      primeira.estudos.inseridos + primeira.estudos.atualizados + primeira.estudos.inalterados,
    ).toBe(conteudo.estudos.length);
    const antes = await obterPool().query(
      "select atualizado_em, conteudo_hash from conteudo.estudo where slug = 'batismo-e-tentacao'",
    );

    const segunda = await carregarConteudo(conteudo);
    expect(segunda.estudos).toEqual({
      inseridos: 0,
      atualizados: 0,
      inalterados: conteudo.estudos.length,
    });
    expect(segunda.trilhas).toEqual({ inseridos: 0, atualizados: 0, inalterados: 3 });
    const depois = await obterPool().query(
      "select atualizado_em, conteudo_hash from conteudo.estudo where slug = 'batismo-e-tentacao'",
    );
    expect(depois.rows).toEqual(antes.rows);

    const estudo = await lerEstudoPorSlug("batismo-e-tentacao");
    expect(estudo).not.toBeNull();
    expect(estudo?.titulo).toBe("Batismo e tentação");
    expect(estudo?.trilha).toEqual({ id: "pontos-centrais", nome: "Pontos centrais", ordem: 2 });
    expect(estudo?.ordem).toBe(3);
    expect(estudo?.grupo).toBe("Quem ele é");
    expect(estudo?.recorte).toBe("devocional");
    expect(estudo?.minutos).toBe(4);
    expect(estudo?.grauDeCerteza).toBeNull();
    expect(estudo?.corpoMd).toContain("## Para hoje");
    expect(estudo?.passagens).toEqual([
      { ordem: 1, inicio: 40003013, fim: 40004011, referenciaTexto: "Mt 3:13 a 4:11" },
    ]);
  });

  it("a Passagem do Estudo são 16 versículos em dois capítulos, lidos por intervalo de chave", async () => {
    const estudo = await lerEstudoPorSlug("batismo-e-tentacao");
    const passagem = await lerPassagem(estudo?.passagens ?? [], "blivre-n4");
    const capitulos = passagem.trechos.flatMap((t) => t.capitulos);
    expect(capitulos.map((c) => [c.capitulo, c.versiculos.length])).toEqual([
      [3, 5],
      [4, 11],
    ]);
    expect(capitulos.flatMap((c) => c.versiculos).length).toBe(16);
    expect(capitulos[0]?.versiculos[0]?.numero).toBe(13);
    expect(capitulos[1]?.versiculos.at(-1)?.numero).toBe(11);
    expect(passagem.trechos[0]?.mesclados).toEqual([]);
  });

  it("o comando content:load imprime inseridos=0 atualizados=0 na segunda execução", () => {
    const saida = execFileSync("pnpm", ["exec", "tsx", "scripts/content/carregar.ts"], {
      cwd: RAIZ,
      env: process.env,
      encoding: "utf8",
      // Processo filho síncrono trava o laço de eventos deste arquivo: sem prazo, uma espera vira eterna.
      timeout: 120_000,
    });
    expect(saida).toContain("inseridos=0 atualizados=0 inalterados=");
    expect(saida).toContain("trilhas inseridas=0 atualizadas=0 inalteradas=3");
  });
});

describe("a carga recusa e desfaz", () => {
  it("referência inválida falha na validação, antes de tocar o banco", async () => {
    const dir = pastaTemporaria();
    writeFileSync(
      path.join(dir, "trilhas", "pontos-centrais", "91-invalido.md"),
      estudoMd("invalido", 91, ["Mt 99:1"]),
    );
    const estudosAntes = await contar("select count(*)::int as n from conteudo.estudo");
    const erro = await lerPasta(dir).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroConteudo);
    expect((erro as Error).message).toContain("91-invalido.md");
    expect((erro as Error).message).toContain("leitura inválida");
    expect(await contar("select count(*)::int as n from conteudo.estudo")).toBe(estudosAntes);
  });

  it("o comando com referência inválida sai com 1 e o banco fica como estava", async () => {
    const dir = pastaTemporaria();
    writeFileSync(
      path.join(dir, "trilhas", "pontos-centrais", "92-invalido.md"),
      estudoMd("invalido-cli", 92, ["Mt 99:1"]),
    );
    const antes = await contar("select count(*)::int as n from conteudo.estudo");
    let saiu = 0;
    try {
      execFileSync("pnpm", ["exec", "tsx", "scripts/content/carregar.ts", "--dir", dir], {
        cwd: RAIZ,
        env: process.env,
        encoding: "utf8",
        // Processo filho síncrono trava o laço de eventos deste arquivo: sem prazo, uma espera vira eterna.
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (erro) {
      saiu = (erro as { status?: number }).status ?? -1;
      expect(String((erro as { stderr?: string }).stderr)).toContain("92-invalido.md");
    }
    expect(saiu).toBe(1);
    expect(await contar("select count(*)::int as n from conteudo.estudo")).toBe(antes);
  });

  it("cada defeito do contrato é recusado com o arquivo e o campo", async () => {
    const casos: [string, string, string][] = [
      ["01-slug-diferente.md", estudoMd("outro-slug", 1, []), "slug"],
      ["01-recorte.md", estudoMd("recorte", 1, []).replace("historico", "devocional2"), "recorte"],
      [
        "01-extra.md",
        estudoMd("extra", 1, []).replace("recorte:", "campo_novo: 1\nrecorte:"),
        "campo_novo",
      ],
      ["01-ordem.md", estudoMd("ordem", 2, []), "ordem"],
      ["01-sem-cerca.md", "sem front matter\n", "front matter"],
    ];
    for (const [nome, texto, trecho] of casos) {
      const dir = pastaTemporaria();
      writeFileSync(path.join(dir, "trilhas", "pontos-centrais", nome), texto);
      const erro = await lerPasta(dir).catch((e: unknown) => e);
      expect(erro, nome).toBeInstanceOf(ErroConteudo);
      expect((erro as Error).message, nome).toContain(trecho);
    }
    // Controle positivo: a mesma forma, correta, é lida.
    const dir = pastaTemporaria();
    writeFileSync(
      path.join(dir, "trilhas", "pontos-centrais", "01-certo.md"),
      estudoMd("certo", 1, ["Mt 3:13 a 4:11"]),
    );
    const lido = await lerPasta(dir);
    expect(lido.estudos).toHaveLength(1);
    expect(lido.estudos[0]?.passagens).toHaveLength(1);
  });

  it("slug repetido e Trilha inexistente são recusados", async () => {
    const dir = pastaTemporaria();
    mkdirSync(path.join(dir, "trilhas", "base-historica"), { recursive: true });
    writeFileSync(
      path.join(dir, "trilhas", "pontos-centrais", "01-igual.md"),
      estudoMd("igual", 1, []),
    );
    writeFileSync(
      path.join(dir, "trilhas", "base-historica", "01-igual.md"),
      estudoMd("igual", 1, []).replace("trilha: pontos-centrais", "trilha: base-historica"),
    );
    const erro = await lerPasta(dir).catch((e: unknown) => e);
    expect((erro as Error).message).toContain("slug repetido");

    const dir2 = pastaTemporaria();
    mkdirSync(path.join(dir2, "trilhas", "inexistente"), { recursive: true });
    const erro2 = await lerPasta(dir2).catch((e: unknown) => e);
    expect((erro2 as Error).message).toContain("sem Trilha correspondente");
  });

  it.skipIf(emNeon())(
    "falha do banco no meio desfaz tudo, inclusive o que já tinha entrado",
    async () => {
      const conteudo = await lerPasta(PASTA_PADRAO);
      const base = conteudo.estudos[0];
      if (!base) throw new Error("sem Estudo de partida");
      const clone = (slug: string) => ({
        ...base,
        frontMatter: { ...base.frontMatter, slug, ordem: 95 },
        // As Afirmações do Estudo de partida pertencem a ele: o clone não as leva.
        afirmacoes: [],
        conteudoHash: slug.padEnd(64, "0").replace(/[^0-9a-f]/g, "a"),
      });
      // O segundo clone repete a posição (trilha, ordem) do primeiro: o banco recusa (23505) já na
      // segunda escrita, depois de o primeiro Estudo ter entrado.
      const antes = await contar("select count(*)::int as n from conteudo.estudo");
      const erro = await carregarConteudo({
        trilhas: conteudo.trilhas,
        estudos: [clone("desfeito-a"), clone("desfeito-b")],
      }).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(ErroDeBanco);
      expect((erro as ErroDeBanco).code).toBe("23505");
      expect(await contar("select count(*)::int as n from conteudo.estudo")).toBe(antes);
      expect(
        await contar("select count(*)::int as n from conteudo.estudo where slug = 'desfeito-a'"),
      ).toBe(0);
    },
  );

  it.skipIf(emNeon())("Estudo que mudou troca as Passagens dele e só as dele", async () => {
    const dir = pastaTemporaria();
    const arquivo = path.join(dir, "trilhas", "pontos-centrais", "93-troca-de-passagens.md");
    writeFileSync(arquivo, estudoMd("troca-de-passagens", 93, ["Mt 3:13-17", "Mt 4:1-3"]));
    const primeira = await carregarConteudo(await lerPasta(dir));
    expect(primeira.estudos.inseridos).toBe(1);
    expect((await lerEstudoPorSlug("troca-de-passagens"))?.passagens).toHaveLength(2);

    writeFileSync(arquivo, estudoMd("troca-de-passagens", 93, ["Mt 3:16"]));
    const segunda = await carregarConteudo(await lerPasta(dir));
    expect(segunda.estudos).toEqual({ inseridos: 0, atualizados: 1, inalterados: 0 });
    expect((await lerEstudoPorSlug("troca-de-passagens"))?.passagens).toEqual([
      { ordem: 1, inicio: 40003016, fim: 40003016, referenciaTexto: "Mt 3:16" },
    ]);
    // O Estudo real não foi tocado.
    expect((await lerEstudoPorSlug("batismo-e-tentacao"))?.passagens).toHaveLength(1);
  });
});
