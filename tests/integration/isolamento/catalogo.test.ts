import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { obterPool } from "@/db/cliente";
import { aplicarEnvDeTeste } from "../../support/preparar-banco";

// Invariante lido do catálogo, sem lista fixa de tabelas: vale também para as tabelas que os
// planos seguintes criarem em `privado`.

beforeAll(() => aplicarEnvDeTeste());
afterAll(async () => {
  await obterPool().end();
});

type LinhaTabela = {
  tabela: string;
  forca: boolean;
  ativa: boolean;
  politicas: number;
  expressoes: string[];
  cascata: boolean;
  dono: string;
};

describe("catálogo: toda tabela de privado é protegida", () => {
  it("RLS ativa e forçada, política por identidade e cascata para auth.user", async () => {
    const r = await obterPool().query<LinhaTabela>(`
      select c.relname as tabela,
             c.relrowsecurity as ativa,
             c.relforcerowsecurity as forca,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as politicas,
             coalesce((select array_agg(pg_get_expr(p.polqual, p.polrelid)) from pg_policy p
                       where p.polrelid = c.oid), '{}') as expressoes,
             exists (
               select 1 from pg_constraint k
               join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
               where k.conrelid = c.oid and k.contype = 'f'
                 and k.confrelid = 'auth."user"'::regclass and k.confdeltype = 'c'
                 and a.attname = 'estudante_id') as cascata,
             pg_get_userbyid(c.relowner) as dono
      from pg_class c
      where c.relnamespace = 'privado'::regnamespace and c.relkind in ('r', 'p')`);
    // Controle: a consulta enxerga tabelas (não passa por estar vazia).
    expect(r.rows.map((l) => l.tabela)).toContain("anotacao");
    for (const t of r.rows) {
      expect(t.ativa, `${t.tabela}: relrowsecurity`).toBe(true);
      expect(t.forca, `${t.tabela}: relforcerowsecurity`).toBe(true);
      expect(t.politicas, `${t.tabela}: políticas`).toBeGreaterThanOrEqual(1);
      expect(
        t.expressoes.every((e) => e.includes("app.estudante_id")),
        `${t.tabela}: política por identidade`,
      ).toBe(true);
      expect(t.cascata, `${t.tabela}: estudante_id → auth.user ON DELETE CASCADE`).toBe(true);
      expect(t.dono, `${t.tabela}: dono`).toBe("jnf_migra");
    }
  });

  it("papéis: nenhum ignora RLS, jnf_app não é dono e o Assistente não entra em privado", async () => {
    const papeis = await obterPool().query<{
      rolname: string;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>(
      "select rolname, rolbypassrls, rolsuper from pg_roles where rolname in ('jnf_app','jnf_migra','jnf_carga','jnf_assistente') order by rolname",
    );
    expect(papeis.rows.map((l) => l.rolname)).toEqual([
      "jnf_app",
      "jnf_assistente",
      "jnf_carga",
      "jnf_migra",
    ]);
    for (const p of papeis.rows) {
      expect(p.rolbypassrls, `${p.rolname}: bypassrls`).toBe(false);
      expect(p.rolsuper, `${p.rolname}: superuser`).toBe(false);
    }
    const donos = await obterPool().query(
      "select count(*)::int as n from pg_class where relowner = 'jnf_app'::regrole and relkind in ('r','p','v','m','S')",
    );
    expect(donos.rows[0]?.n).toBe(0);
    const uso = await obterPool().query<{
      assistente_privado: boolean;
      app_privado: boolean;
      assistente_acervo: boolean;
    }>(
      `select has_schema_privilege('jnf_assistente', 'privado', 'USAGE') as assistente_privado,
              has_schema_privilege('jnf_app', 'privado', 'USAGE') as app_privado,
              has_schema_privilege('jnf_assistente', 'acervo', 'USAGE') as assistente_acervo`,
    );
    expect(uso.rows[0]?.assistente_privado).toBe(false);
    // Controles positivos: a consulta distingue quem tem de quem não tem.
    expect(uso.rows[0]?.app_privado).toBe(true);
    expect(uso.rows[0]?.assistente_acervo).toBe(true);
  });
});
