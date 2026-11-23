import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { obterPool } from "@/db/cliente";
import {
  type BancoDeExecucao,
  criarBancoPreparado,
  removerBancoDeExecucao,
} from "../../support/banco-local";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Varredura do catálogo do esquema `acervo`, sem lista fixa de tabelas existentes: toda tabela precisa
// estar CLASSIFICADA aqui como pública ou protegida. Tabela nova sem classificação faz o teste falhar,
// dizendo o nome. Só leitura do catálogo (roda também no Neon dev). Os planos 05 e 19 acrescentam as
// tabelas deles às listas (verificação por função, aprovação de Afirmação, proposta de grau).

// Conteúdo público de referência: qualquer um dos papéis lê, sem política de linha.
const PUBLICAS = [
  "ambiente",
  "conjunto_dados",
  "livro",
  "versiculo",
  "texto",
  "texto_versiculo",
  "correspondencia_versificacao",
  "afirmacao",
  // Do plano 19 em diante, a Citação só é visível quando aprovada (RLS): passa à lista abaixo.
  "citacao",
] as const;

// Conteúdo que depende de estado (publicada, verificada, sessão de Admin): RLS ligada e política.
const PROTEGIDAS = [
  "fonte",
  "fonte_secao",
  "fonte_paragrafo",
  "ficha",
  "ficha_item",
  "conferencia_item",
  "verificacao_ficha",
] as const;

// Evidência: ninguém da aplicação escreve; só as funções do banco (plano 05).
const EVIDENCIAS = ["conferencia_item", "verificacao_ficha"] as const;
const PAPEIS = ["jnf_carga", "jnf_app", "jnf_assistente"] as const;

type Consulta = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

/** Nomes das tabelas do esquema `acervo`, lidos do catálogo. */
async function tabelasDoAcervo(consultar: Consulta): Promise<string[]> {
  const r = await consultar(
    `select c.relname as nome from pg_class c
      where c.relnamespace = 'acervo'::regnamespace and c.relkind in ('r', 'p') order by 1`,
  );
  return r.rows.map((l) => String(l.nome));
}

/** O que está no catálogo e não está em nenhuma das duas listas. */
function semClassificacao(nomes: readonly string[]): string[] {
  const conhecidas = new Set<string>([...PUBLICAS, ...PROTEGIDAS]);
  return nomes.filter((nome) => !conhecidas.has(nome));
}

function mensagemDeClassificacao(faltam: readonly string[]): string {
  return `tabela do esquema acervo sem classificação: ${faltam.join(", ")}. Classifique-a em PUBLICAS ou PROTEGIDAS (tests/integration/isolamento/catalogo-acervo.test.ts); a protegida precisa de RLS e política.`;
}

beforeAll(() => aplicarEnvDeTeste());
afterAll(async () => {
  await obterPool().end();
});

const consultarNoPool: Consulta = (sql, params) => obterPool().query(sql, params);

describe("catálogo: toda tabela do Acervo está classificada", () => {
  it("cada tabela de acervo é pública ou protegida, e as listas não guardam nome que já não existe", async () => {
    const nomes = await tabelasDoAcervo(consultarNoPool);
    // Controle positivo: o catálogo enxerga tabelas de cada classe, e as de evidência.
    expect(nomes).toEqual(expect.arrayContaining(["fonte", "verificacao_ficha", "versiculo"]));
    const faltam = semClassificacao(nomes);
    expect(faltam, mensagemDeClassificacao(faltam)).toEqual([]);
    for (const nome of [...PUBLICAS, ...PROTEGIDAS]) expect(nomes, nome).toContain(nome);
    // Uma tabela não é as duas coisas ao mesmo tempo.
    expect(PROTEGIDAS.filter((p) => (PUBLICAS as readonly string[]).includes(p))).toEqual([]);
  });

  it("toda protegida tem RLS ligada e ao menos uma política que cite jnf_app ou jnf_assistente", async () => {
    const r = await consultarNoPool(
      `select c.relname as tabela, c.relrowsecurity as ativa,
              exists (select 1 from pg_policy p
                       where p.polrelid = c.oid
                         and p.polroles && array['jnf_app'::regrole::oid, 'jnf_assistente'::regrole::oid])
                as politica_de_leitura,
              pg_get_userbyid(c.relowner) as dono
         from pg_class c
        where c.relnamespace = 'acervo'::regnamespace and c.relkind in ('r', 'p')`,
    );
    const porNome = new Map(r.rows.map((l) => [String(l.tabela), l]));
    for (const nome of PROTEGIDAS) {
      const linha = porNome.get(nome);
      expect(linha, `${nome}: existe no catálogo`).toBeDefined();
      expect(linha?.ativa, `${nome}: relrowsecurity`).toBe(true);
      expect(linha?.politica_de_leitura, `${nome}: política para jnf_app/jnf_assistente`).toBe(
        true,
      );
      expect(linha?.dono, `${nome}: dono`).toBe("jnf_migra");
    }
    // Controle negativo do instrumento: uma tabela pública não tem RLS (a consulta distingue).
    expect(porNome.get("versiculo")?.ativa).toBe(false);
  });

  it("jnf_carga tem política própria nas tabelas de conteúdo protegidas (sem ela a carga não leria o que gravou)", async () => {
    const r = await consultarNoPool(
      `select c.relname as tabela
         from pg_class c
        where c.relnamespace = 'acervo'::regnamespace and c.relkind in ('r', 'p')
          and exists (select 1 from pg_policy p
                       where p.polrelid = c.oid and p.polroles && array['jnf_carga'::regrole::oid])`,
    );
    const comPolitica = r.rows.map((l) => String(l.tabela)).sort();
    expect(comPolitica).toEqual(
      ["fonte", "fonte_secao", "fonte_paragrafo", "ficha", "ficha_item"].sort(),
    );
  });

  it("as tabelas de evidência não têm insert, update, delete nem truncate para nenhum papel da aplicação", async () => {
    const todas = await consultarNoPool(
      `select t.nome as tabela, p.papel,
              has_table_privilege(p.papel, 'acervo.' || t.nome, 'insert') as i,
              has_table_privilege(p.papel, 'acervo.' || t.nome, 'update') as u,
              has_table_privilege(p.papel, 'acervo.' || t.nome, 'delete') as d,
              has_table_privilege(p.papel, 'acervo.' || t.nome, 'truncate') as t,
              has_table_privilege(p.papel, 'acervo.' || t.nome, 'select') as s
         from unnest($1::text[]) as t(nome), unnest($2::text[]) as p(papel)`,
      [[...EVIDENCIAS, "fonte"], [...PAPEIS]],
    );
    for (const l of todas.rows) {
      const onde = `${l.papel} em ${l.tabela}`;
      if (l.tabela === "fonte") continue;
      expect(l.i, `${onde}: insert`).toBe(false);
      expect(l.u, `${onde}: update`).toBe(false);
      expect(l.d, `${onde}: delete`).toBe(false);
      expect(l.t, `${onde}: truncate`).toBe(false);
    }
    // Controles positivos: a mesma consulta vê privilégio onde ele existe.
    const carga = todas.rows.find((l) => l.tabela === "fonte" && l.papel === "jnf_carga");
    expect(carga?.i, "jnf_carga insere em fonte").toBe(true);
    const app = todas.rows.find((l) => l.tabela === "verificacao_ficha" && l.papel === "jnf_app");
    expect(app?.s, "jnf_app lê verificacao_ficha").toBe(true);
    // E o registro de quem agiu, no esquema admin, também não tem escrita para ninguém da aplicação.
    const registro = await consultarNoPool(
      `select p as papel,
              has_table_privilege(p, 'admin.registro_verificacao', 'insert') as i,
              has_table_privilege(p, 'admin.registro_verificacao', 'update') as u,
              has_table_privilege(p, 'admin.registro_verificacao', 'delete') as d
         from unnest($1::text[]) as p`,
      [[...PAPEIS]],
    );
    for (const l of registro.rows) {
      expect([l.i, l.u, l.d], `${l.papel} em admin.registro_verificacao`).toEqual([
        false,
        false,
        false,
      ]);
    }
  });

  it("nenhum papel da aplicação tem truncate em tabela alguma do Acervo", async () => {
    const r = await consultarNoPool(
      `select c.relname as tabela, p as papel
         from pg_class c, unnest($1::text[]) as p
        where c.relnamespace = 'acervo'::regnamespace and c.relkind in ('r', 'p')
          and has_table_privilege(p, c.oid, 'truncate')`,
      [[...PAPEIS]],
    );
    expect(r.rows).toEqual([]);
  });
});

// Prova, num banco descartável, que o teste falha quando alguém cria uma tabela sem classificá-la e
// que a mensagem diz o nome. O banco é removido; nada fica.
const emNeon = () => inject("alvoBanco") === "neon";

describe.skipIf(emNeon())("a varredura falha para tabela nova sem classificação", () => {
  let banco: BancoDeExecucao | undefined;
  let dono: pg.Client;

  beforeAll(async () => {
    const preparado = await criarBancoPreparado();
    banco = preparado.banco;
    dono = new pg.Client({ connectionString: preparado.banco.url });
    await dono.connect();
  }, 120_000);

  afterAll(async () => {
    await dono?.end().catch(() => {});
    if (banco) await removerBancoDeExecucao(banco.nome);
  });

  it("limpo: nenhuma tabela sem classificação; com tabela fictícia: o nome aparece", async () => {
    const consultar: Consulta = (sql, params) => dono.query(sql, params);
    expect(semClassificacao(await tabelasDoAcervo(consultar))).toEqual([]);
    await dono.query("create table acervo.tabela_fantasma (id int)");
    const faltam = semClassificacao(await tabelasDoAcervo(consultar));
    expect(faltam).toEqual(["tabela_fantasma"]);
    expect(mensagemDeClassificacao(faltam)).toContain("tabela_fantasma");
    await dono.query("drop table acervo.tabela_fantasma");
    expect(semClassificacao(await tabelasDoAcervo(consultar))).toEqual([]);
  });
});
