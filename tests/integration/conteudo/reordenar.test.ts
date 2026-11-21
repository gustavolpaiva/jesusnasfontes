import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { carregarConteudo, PASTA_PADRAO } from "../../../scripts/content/carregar";
import { lerPasta } from "../../../scripts/content/esquema";
import { criarBancoPreparado, removerBancoDeExecucao } from "../../support/banco-local";
import { semearTexto } from "../../support/preparar-banco";

// Revisão da fase (plano 01-20): trocar a ordem de duas Trilhas, ou de dois Estudos da mesma Trilha, já carregados
// violava UNIQUE(ordem) e UNIQUE(trilha, ordem) no primeiro upsert e desfazia toda a carga, embora o conteúdo final
// fosse válido. Banco descartável: a carga escreve em conteudo.* e nunca deve tocar o banco compartilhado.

const emNeon = () => inject("alvoBanco") === "neon";
let banco: Awaited<ReturnType<typeof criarBancoPreparado>>["banco"];

beforeAll(async () => {
  if (emNeon()) return;
  const criado = await criarBancoPreparado();
  banco = criado.banco;
  Object.assign(process.env, criado.env);
  await semearTexto({ livros: [40, 41, 42, 43, 46] }, criado.env);
});

afterAll(async () => {
  if (emNeon()) return;
  await obterPool().end();
  await removerBancoDeExecucao(banco.nome);
});

const ordemDasTrilhas = async () =>
  (await obterPool().query("select id, ordem from conteudo.trilha order by id")).rows;

describe.skipIf(emNeon())("a carga aceita trocar a ordem de itens já carregados", () => {
  it("duas Trilhas trocam de ordem", async () => {
    const conteudo = await lerPasta(PASTA_PADRAO);
    await carregarConteudo(conteudo);
    const [a, b] = conteudo.trilhas;
    if (!a || !b) throw new Error("o conteúdo precisa de ao menos duas Trilhas");
    const trocado = {
      ...conteudo,
      trilhas: conteudo.trilhas.map((t) =>
        t.id === a.id ? { ...t, ordem: b.ordem } : t.id === b.id ? { ...t, ordem: a.ordem } : t,
      ),
    };
    await carregarConteudo(trocado);
    const linhas = await ordemDasTrilhas();
    expect(linhas.find((l) => l.id === a.id)?.ordem).toBe(b.ordem);
    expect(linhas.find((l) => l.id === b.id)?.ordem).toBe(a.ordem);
  }, 120_000);

  it("dois Estudos da mesma Trilha trocam de ordem", async () => {
    const conteudo = await lerPasta(PASTA_PADRAO);
    await carregarConteudo(conteudo);
    const [x, y] = conteudo.estudos.filter(
      (e) => e.frontMatter.trilha === conteudo.estudos[0]?.frontMatter.trilha,
    );
    if (!x || !y) throw new Error("o conteúdo precisa de dois Estudos na mesma Trilha");
    const novoHash = (e: typeof x, n: string) => ({ ...e, conteudoHash: n.repeat(64) });
    const trocado = {
      ...conteudo,
      estudos: conteudo.estudos.map((e) =>
        e === x
          ? { ...novoHash(e, "a"), frontMatter: { ...e.frontMatter, ordem: y.frontMatter.ordem } }
          : e === y
            ? { ...novoHash(e, "b"), frontMatter: { ...e.frontMatter, ordem: x.frontMatter.ordem } }
            : e,
      ),
    };
    await carregarConteudo(trocado);
    const r = await obterPool().query(
      "select slug, ordem from conteudo.estudo where slug = any($1)",
      [[x.frontMatter.slug, y.frontMatter.slug]],
    );
    expect(r.rows.find((l) => l.slug === x.frontMatter.slug)?.ordem).toBe(y.frontMatter.ordem);
    expect(r.rows.find((l) => l.slug === y.frontMatter.slug)?.ordem).toBe(x.frontMatter.ordem);
  }, 120_000);
});
