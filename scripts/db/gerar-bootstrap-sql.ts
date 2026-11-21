import { pathToFileURL } from "node:url";
import { PAPEIS, PRIVILEGIOS_PADRAO, USO_DO_ESQUEMA } from "./bootstrap-papeis";

// pnpm exec tsx scripts/db/gerar-bootstrap-sql.ts > operacao/producao/bootstrap-papeis.sql
//
// Imprime o SQL que equivale a scripts/db/bootstrap-papeis.ts, para o DONO colar e rodar uma vez no
// editor SQL do Neon de produção. Não lê ambiente, não conecta e não contém senha: no lugar de cada
// uma há um marcador <SENHA_JNF_*> que o dono troca na tela do Neon. Os esquemas e os privilégios
// vêm das mesmas constantes do script (uma fonte só).

export const MARCADORES: Record<(typeof PAPEIS)[number], string> = {
  migra: "<SENHA_JNF_MIGRA>",
  app: "<SENHA_JNF_APP>",
  carga: "<SENHA_JNF_CARGA>",
  assistente: "<SENHA_JNF_ASSISTENTE>",
};

export function gerarBootstrapSql(): string {
  const l: string[] = [];
  l.push(
    "-- Papéis, extensão, busca, esquemas e privilégios do banco de produção (jesusnasfontes-prod).",
    "-- Gerado por scripts/db/gerar-bootstrap-sql.ts; equivale a scripts/db/bootstrap-papeis.ts. Idempotente.",
    "--",
    "-- ANTES DE RODAR: troque cada marcador <SENHA_JNF_*> pela senha do ambiente prod do cofre, mantendo",
    "-- as aspas simples em volta. As senhas não podem conter aspas simples (' ); as do cofre são geradas sem.",
    "-- Rode no editor SQL do Neon, projeto jesusnasfontes-prod, como o dono do banco, com o banco certo",
    "-- selecionado. Não cole este arquivo, já com as senhas, em nenhum lugar fora do editor.",
    "",
    "-- 1) Papéis (criação só se faltar; atributos e senha sempre conferidos)",
  );
  for (const papel of PAPEIS) {
    const nome = `jnf_${papel}`;
    l.push(
      `do $$ begin`,
      `  if not exists (select 1 from pg_roles where rolname = '${nome}') then`,
      `    create role ${nome} login nocreatedb nocreaterole;`,
      `  end if;`,
      `end $$;`,
      `alter role ${nome} login nocreatedb nocreaterole password '${MARCADORES[papel]}';`,
    );
  }
  l.push(
    "",
    "-- 2) O dono do banco (não é superusuário no Neon) precisa poder assumir o jnf_migra para criar esquemas em nome dele",
    "grant jnf_migra to current_user with inherit true, set true;",
    "",
    "-- 3) Extensão e configuração de busca em português sem acento",
    "create extension if not exists unaccent;",
    "do $$ begin",
    "  if not exists (select 1 from pg_ts_config where cfgname = 'pt_unaccent') then",
    "    create text search configuration public.pt_unaccent (copy = pg_catalog.portuguese);",
    "    alter text search configuration public.pt_unaccent alter mapping for hword, hword_part, word with unaccent, portuguese_stem;",
    "  end if;",
    "end $$;",
    "",
    "-- 4) Esquemas, dono jnf_migra, uso só para quem lê",
  );
  for (const [esquema, leitores] of Object.entries(USO_DO_ESQUEMA)) {
    l.push(
      `create schema if not exists ${esquema} authorization jnf_migra;`,
      `revoke all on schema ${esquema} from public;`,
    );
    for (const leitor of leitores) l.push(`grant usage on schema ${esquema} to jnf_${leitor};`);
  }
  l.push("", "-- 5) Privilégios padrão das tabelas que o jnf_migra criar (as migrações)");
  for (const { esquema, privilegios, papel } of PRIVILEGIOS_PADRAO) {
    l.push(
      `alter default privileges for role jnf_migra in schema ${esquema} grant ${privilegios} on tables to jnf_${papel};`,
    );
  }
  l.push(
    "",
    "-- 6) Conferência (sem senha): quatro linhas, todas com superusuário e bypassrls falsos",
    "select rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole",
    "from pg_roles where rolname in ('jnf_app', 'jnf_migra', 'jnf_carga', 'jnf_assistente') order by rolname;",
    "",
  );
  return l.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(gerarBootstrapSql());
}
