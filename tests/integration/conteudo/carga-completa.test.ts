import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { obterPool } from "@/db/cliente";
import { lerEstudoPorSlug } from "@/modules/conteudo/estudo";
import { carregarConteudo, PASTA_PADRAO } from "../../../scripts/content/carregar";
import { conferirContagens, lerPasta } from "../../../scripts/content/esquema";
import { ErroCarga } from "../../../scripts/ingest/carregar-biblia";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { semearTexto } from "../../support/preparar-banco";

// O conteúdo completo de content/ (8 + 30 + 89 Estudos, 3 conjuntos de perguntas, as Afirmações e as
// Divergências) carregado de ponta a ponta. Cria Estudos e Citações de teste, então usa um banco
// descartável SÓ deste arquivo (o compartilhado conta os Estudos em outros testes) e não roda no Neon.

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// A carga inteira (127 Estudos) passa de 30 s com a máquina ocupada. Um teste abandonado por prazo deixa
// a carga a meio caminho, segurando a trava; o teste seguinte chama o comando de forma síncrona e os dois
// ficam esperando um pelo outro (visto em 20/11/2026: 5 horas parado).
vi.setConfig({ testTimeout: 180_000 });

const emNeon = () => inject("alvoBanco") === "neon";
const temporarios: string[] = [];
let banco: BancoDeExecucao | undefined;

async function comoDono<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
  await cliente.connect();
  try {
    return await fn(cliente);
  } finally {
    await cliente.end();
  }
}

const contar = (sql: string, params: unknown[] = []) =>
  comoDono(async (c) => (await c.query<{ n: number }>(sql, params)).rows[0]?.n ?? -1);

// Uma cópia editável de content/: o teste muda a cópia, nunca o original.
function copiaDoConteudo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "jnf-completo-"));
  temporarios.push(dir);
  cpSync(PASTA_PADRAO, dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  if (emNeon()) return;
  const preparado = await criarBancoPreparado();
  banco = preparado.banco;
  Object.assign(process.env, preparado.env);
  await semearTexto({ livros: [40, 41, 42, 43, 46] });
}, 120_000);

afterAll(async () => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
  if (emNeon()) return;
  await obterPool().end();
  if (banco) await removerBancoDeExecucao(banco.nome);
});

describe.skipIf(emNeon())("content/ completo: 8 + 30 + 89 e os 3 conjuntos de perguntas", () => {
  it("a pasta padrão tem as contagens do contrato e a carga as grava", async () => {
    const conteudo = await lerPasta(PASTA_PADRAO);
    conferirContagens(conteudo);
    const por = (t: string) => conteudo.estudos.filter((e) => e.frontMatter.trilha === t).length;
    expect([por("base-historica"), por("pontos-centrais"), por("leitura-continua")]).toEqual([
      8, 30, 89,
    ]);
    expect(conteudo.perguntas).toHaveLength(3);

    const r = await carregarConteudo(conteudo);
    expect(r.estudos).toEqual({ inseridos: 127, atualizados: 0, inalterados: 0 });

    const porTrilha = await comoDono((c) =>
      c.query<{ trilha_id: string; n: number }>(
        "select trilha_id, count(*)::int as n from conteudo.estudo group by 1 order by 1",
      ),
    );
    expect(porTrilha.rows.map((l) => [l.trilha_id, l.n])).toEqual([
      ["base-historica", 8],
      ["leitura-continua", 89],
      ["pontos-centrais", 30],
    ]);
    expect(await contar("select count(*)::int as n from conteudo.pergunta_volta")).toBe(9);
    expect(
      await contar("select count(distinct conjunto)::int as n from conteudo.pergunta_volta"),
    ).toBe(3);

    // Toda Afirmação extraída está guardada com id, texto e hash, presa ao Estudo dela.
    const extraidas = conteudo.estudos.flatMap((e) => e.afirmacoes);
    expect(extraidas.length).toBeGreaterThanOrEqual(38);
    expect(await contar("select count(*)::int as n from acervo.afirmacao")).toBe(extraidas.length);
    expect(
      await contar(
        "select count(*)::int as n from acervo.afirmacao where estudo_id is null or texto_hash !~ '^[0-9a-f]{64}$'",
      ),
    ).toBe(0);
    expect(await contar("select count(*)::int as n from conteudo.divergencia")).toBe(4);
    // 17, 19 e 26 têm as três tradições; 21 tem duas (a nota só nomeia católicos e protestantes); a do "por nós" (29) foi removida.
    expect(await contar("select count(*)::int as n from conteudo.divergencia_leitura")).toBe(11);
    // A Leitura contínua leva livro e capítulo nas colunas.
    expect(
      await contar(
        "select count(*)::int as n from conteudo.estudo where trilha_id = 'leitura-continua' and livro between 40 and 43 and capitulo > 0",
      ),
    ).toBe(89);
    // Mateus 28 é o último capítulo de Mateus; João 21, o último dos quatro.
    expect(
      await contar(
        "select count(*)::int as n from conteudo.estudo where slug in ('mateus-28', 'joao-21')",
      ),
    ).toBe(2);
  }, 120_000);

  it("o Estudo volta pelo slug com Afirmações, Divergência na ordem fixa e perguntas", async () => {
    const nicodemos = await lerEstudoPorSlug("nicodemos-nascer-de-novo");
    expect(nicodemos?.afirmacoes.map((a) => a.id)).toEqual(["pc17-a1"]);
    expect(nicodemos?.divergencias).toHaveLength(1);
    expect(nicodemos?.divergencias[0]?.leituras.map((l) => l.tradicao)).toEqual([
      "catolica",
      "ortodoxa",
      "protestante",
    ]);
    // O Estudo sem tradição nomeada na nota de origem (d21) tem só as duas que a nota nomeia.
    const pedra = await lerEstudoPorSlug("quem-voces-dizem-que-eu-sou");
    expect(pedra?.divergencias[0]?.leituras.map((l) => l.tradicao)).toEqual([
      "catolica",
      "protestante",
    ]);
    const capitulo = await lerEstudoPorSlug("mateus-5");
    expect(capitulo?.perguntas).toHaveLength(3);
    expect(capitulo?.perguntas.every((c) => c.length === 3)).toBe(true);
    expect(capitulo?.passagens).toHaveLength(1);
    // Fora da Leitura contínua não vêm perguntas.
    expect((await lerEstudoPorSlug("nicodemos-nascer-de-novo"))?.perguntas).toEqual([]);
    // Os 8 textos de certeza chegam, sem valor e sem revisão (a classificação é do dono).
    const f1 = await lerEstudoPorSlug("o-que-a-historia-consegue-afirmar");
    expect(f1?.grauDeCerteza).toEqual({
      valor: null,
      texto: expect.stringContaining("praticamente unânime"),
      revisado: false,
    });
  });

  it("a segunda carga, sem alteração, não muda nada", async () => {
    const conteudo = await lerPasta(PASTA_PADRAO);
    const r = await carregarConteudo(conteudo);
    expect(r.estudos).toEqual({ inseridos: 0, atualizados: 0, inalterados: 127 });
    expect(r.trilhas).toEqual({ inseridos: 0, atualizados: 0, inalterados: 3 });
    expect(r.afirmacoes).toMatchObject({ inseridos: 0, atualizados: 0, removidas: 0 });
    expect(r.perguntas).toBe(0);
  });

  it("o comando content:load relata 8, 30, 89 e os 3 conjuntos, e a segunda execução não muda", () => {
    const saida = execFileSync("pnpm", ["exec", "tsx", "scripts/content/carregar.ts"], {
      cwd: RAIZ,
      env: process.env,
      encoding: "utf8",
      // Processo filho síncrono trava o laço de eventos deste arquivo: sem prazo, uma espera vira eterna.
      timeout: 120_000,
    });
    expect(saida).toContain("inseridos=0 atualizados=0 inalterados=127");
    expect(saida).toContain(
      "carregado: base-historica=8 pontos-centrais=30 leitura-continua=89 conjuntos-de-perguntas=3",
    );
  });
});

describe.skipIf(emNeon())(
  "Afirmação com Citação: o id e o texto não mudam sem revisar a Citação",
  () => {
    const ID = "bh01-a1";
    const FRASE = "Lucas abre dizendo que investigou tudo desde o início";

    async function criarCitacao(): Promise<void> {
      await comoDono(async (c) => {
        await c.query(
          "insert into acervo.fonte (id, slug, nivel, titulo, tipo_texto, licenca, origem_url) values ('00000000-0000-4000-8000-000000000012', 'fonte-de-teste', 'primaria', 'Fonte de teste', 'integral', 'dominio-publico', 'https://exemplo.invalid/t') on conflict do nothing",
        );
        await c.query(
          "insert into acervo.fonte_secao (id, fonte_id, slug, ordem) values ('teste-s1', '00000000-0000-4000-8000-000000000012', 's1', 1) on conflict do nothing",
        );
        await c.query(
          "insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref) values ('teste-p1', 'teste-s1', 1, 'x', 'p1') on conflict do nothing",
        );
        await c.query(
          "insert into acervo.citacao (afirmacao_id, fonte_paragrafo_id, ordem) values ($1, 'teste-p1', 1)",
          [ID],
        );
      });
    }
    const apagarCitacao = () =>
      comoDono((c) => c.query("delete from acervo.citacao where afirmacao_id = $1", [ID]));
    const arquivoDoEstudo = (dir: string) =>
      path.join(dir, "trilhas", "base-historica", "01-o-que-a-historia-consegue-afirmar.md");
    const textoDoBanco = () =>
      comoDono(
        async (c) =>
          (
            await c.query<{ texto: string }>("select texto from acervo.afirmacao where id = $1", [
              ID,
            ])
          ).rows[0]?.texto,
      );

    it("mudar o texto muda o hash; com Citação a carga recusa, nomeia o id e desfaz tudo", async () => {
      const dir = copiaDoConteudo();
      const original = readFileSync(arquivoDoEstudo(dir), "utf8");
      expect(original).toContain(`:afirmacao[${FRASE}`);
      const antes = await textoDoBanco();
      const hashAntes = await contar(
        "select (texto_hash = encode(sha256(texto::bytea), 'hex'))::int as n from acervo.afirmacao where id = $1",
        [ID],
      );
      expect(hashAntes).toBe(1);

      // Sem Citação, mudar o texto é aceito e o hash acompanha (controle positivo).
      writeFileSync(
        arquivoDoEstudo(dir),
        original.replace(FRASE, "Lucas abriu dizendo que investigou tudo desde o início"),
      );
      const aceita = await carregarConteudo(await lerPasta(dir));
      expect(aceita.afirmacoes.atualizados).toBe(1);
      expect(await textoDoBanco()).not.toBe(antes);
      expect(
        await contar(
          "select (texto_hash = encode(sha256(convert_to(texto, 'UTF8')), 'hex'))::int as n from acervo.afirmacao where id = $1",
          [ID],
        ),
      ).toBe(1);
      // Volta ao original para o resto do teste.
      writeFileSync(arquivoDoEstudo(dir), original);
      await carregarConteudo(await lerPasta(dir));
      expect(await textoDoBanco()).toBe(antes);

      // Com Citação, mudar o texto é recusado.
      await criarCitacao();
      try {
        writeFileSync(
          arquivoDoEstudo(dir),
          original.replace(FRASE, "Lucas abriu dizendo que investigou tudo desde o início"),
        );
        const erro = await carregarConteudo(await lerPasta(dir)).catch((e: unknown) => e);
        expect(erro).toBeInstanceOf(ErroCarga);
        expect((erro as Error).message).toContain(ID);
        expect((erro as Error).message).toContain("Citação");
        expect(await textoDoBanco()).toBe(antes);
      } finally {
        await apagarCitacao();
      }
    }, 120_000);

    it("remover o id do conteúdo é recusado quando ele tem Citação, e aceito quando não tem", async () => {
      const dir = copiaDoConteudo();
      const original = readFileSync(arquivoDoEstudo(dir), "utf8");
      // O mesmo texto, sem a marcação: o id sai do conteúdo.
      const semMarca = original.replace(new RegExp(`:afirmacao\\[([^\\]]*)\\]\\{#${ID}\\}`), "$1");
      expect(semMarca).not.toContain(`#${ID}`);

      await criarCitacao();
      try {
        writeFileSync(arquivoDoEstudo(dir), semMarca);
        const erro = await carregarConteudo(await lerPasta(dir)).catch((e: unknown) => e);
        expect(erro).toBeInstanceOf(ErroCarga);
        expect((erro as Error).message).toContain(ID);
        expect(
          await contar("select count(*)::int as n from acervo.afirmacao where id = $1", [ID]),
        ).toBe(1);
      } finally {
        await apagarCitacao();
      }

      // Sem Citação, a mesma remoção é aceita e o id sai do banco.
      const aceita = await carregarConteudo(await lerPasta(dir));
      expect(aceita.afirmacoes.removidas).toBe(1);
      expect(
        await contar("select count(*)::int as n from acervo.afirmacao where id = $1", [ID]),
      ).toBe(0);
      // Restaura o original: o id volta (ele nunca foi reutilizado por outro texto).
      writeFileSync(arquivoDoEstudo(dir), original);
      const volta = await carregarConteudo(await lerPasta(dir));
      expect(volta.afirmacoes.inseridos).toBe(1);
    }, 120_000);
  },
);
