import { pathToFileURL } from "node:url";
import pg from "pg";
import { envBanco, envBootstrap } from "../../src/lib/env";
import { registrarErro } from "../../src/lib/registro";

// Cria (ou ajusta) papéis, extensão, configuração de busca, esquemas e privilégios.
// Idempotente. Conecta como dono do banco (ou superusuário do contêiner local). As senhas vêm do
// ambiente e nunca são impressas nem gravadas em SQL versionado.

export type Senhas = { app: string; migra: string; carga: string; assistente: string };

const PAPEIS = ["migra", "app", "carga", "assistente"] as const;

// Esquema → quem lê (USAGE). A escrita por papel está nos privilégios padrão abaixo.
const USO_DO_ESQUEMA: Record<string, string[]> = {
  acervo: ["app", "carga", "assistente"],
  conteudo: ["app", "carga"],
  privado: ["app"],
  admin: ["app"],
  auth: ["app"],
};

const DML = "select, insert, update, delete";

export async function bootstrapPapeis(urlDono: string, senhas: Senhas): Promise<void> {
  const cliente = new pg.Client({ connectionString: urlDono });
  await cliente.connect();
  let etapa = "inicio";
  try {
    const super_ = await cliente.query<{ rolsuper: boolean }>(
      "select rolsuper from pg_roles where rolname = current_user",
    );
    const souSuper = super_.rows[0]?.rolsuper === true;

    for (const papel of PAPEIS) {
      const nome = `jnf_${papel}`;
      etapa = `papel ${nome}`;
      const existe = await cliente.query("select 1 from pg_roles where rolname = $1", [nome]);
      if (existe.rowCount === 0) {
        // Os padrões do servidor já são NOSUPERUSER e NOBYPASSRLS; quem não é superusuário não pode
        // nem citar esses atributos (a Neon recusa com 42501). O teste de catálogo prova o resultado.
        await cliente.query(`create role ${nome} login nocreatedb nocreaterole`);
      }
      await cliente.query(
        `alter role ${nome} login nocreatedb nocreaterole${souSuper ? " nosuperuser nobypassrls" : ""}`,
      );
      etapa = `senha de ${nome}`;
      // Utilitário não aceita parâmetro: o servidor monta o comando com %L e o executamos.
      const comando = await cliente.query<{ c: string }>(
        "select format('alter role %I password %L', $1::text, $2::text) as c",
        [nome, senhas[papel]],
      );
      await cliente.query(comando.rows[0]?.c ?? "select 1");
    }

    etapa = "membership";
    // Sem superusuário, criar objeto "para" outro papel exige poder assumi-lo.
    if (!souSuper) {
      await cliente.query("grant jnf_migra to current_user with inherit true, set true");
    }

    etapa = "extensao e busca";
    await cliente.query("create extension if not exists unaccent");
    const busca = await cliente.query("select 1 from pg_ts_config where cfgname = 'pt_unaccent'");
    if (busca.rowCount === 0) {
      await cliente.query(
        "create text search configuration public.pt_unaccent (copy = pg_catalog.portuguese)",
      );
      await cliente.query(
        "alter text search configuration public.pt_unaccent alter mapping for hword, hword_part, word with unaccent, portuguese_stem",
      );
    }

    for (const [esquema, leitores] of Object.entries(USO_DO_ESQUEMA)) {
      etapa = `esquema ${esquema}`;
      await cliente.query(`create schema if not exists ${esquema} authorization jnf_migra`);
      await cliente.query(`revoke all on schema ${esquema} from public`);
      for (const leitor of leitores) {
        await cliente.query(`grant usage on schema ${esquema} to jnf_${leitor}`);
      }
    }

    etapa = "privilegios padrao";
    const padrao = (esquema: string, privilegios: string, papel: string) =>
      cliente.query(
        `alter default privileges for role jnf_migra in schema ${esquema} grant ${privilegios} on tables to jnf_${papel}`,
      );
    for (const esquema of ["privado", "admin", "auth"]) await padrao(esquema, DML, "app");
    await padrao("acervo", "select", "app");
    await padrao("conteudo", "select", "app");
    await padrao("acervo", DML, "carga");
    await padrao("conteudo", DML, "carga");
    await padrao("acervo", "select", "assistente");
  } catch (erro) {
    // O rótulo da etapa é texto fixo daqui: seguro para o terminal.
    console.error(`bootstrap falhou na etapa: ${etapa}`);
    throw erro;
  } finally {
    await cliente.end();
  }
}

async function principal(): Promise<void> {
  const env = envBanco();
  await bootstrapPapeis(envBootstrap().DATABASE_URL_OWNER, {
    app: env.JNF_APP_PASSWORD,
    migra: env.JNF_MIGRA_PASSWORD,
    carga: env.JNF_CARGA_PASSWORD,
    assistente: env.JNF_ASSISTENTE_PASSWORD,
  });
  console.log("bootstrap: papéis, extensão, busca, esquemas e privilégios conferidos");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  principal().catch((erro) => {
    registrarErro("bootstrap-papeis", erro);
    process.exit(1);
  });
}
