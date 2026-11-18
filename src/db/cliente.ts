import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { registrarErro } from "@/lib/registro";
import { urlDoPapel } from "./url";

export type Cliente = { pool: pg.Pool; db: ReturnType<typeof criarDb> };

function criarDb(pool: pg.Pool) {
  // Sem logger: o log de consultas do Drizzle imprimiria parâmetros, e entre eles o texto da Anotação.
  return drizzle(pool);
}

// Pool do papel jnf_app pela URL agrupada. `max` pequeno: o agrupador do Neon faz o resto.
export function criarCliente(opcoes: { max: number } = { max: 5 }): Cliente {
  const pool = new pg.Pool({
    connectionString: urlDoPapel("app", { agrupada: true }),
    max: opcoes.max,
  });
  // Erro de conexão ociosa não pode derrubar o processo nem ir ao registro com texto livre.
  pool.on("error", (erro) => registrarErro("pool", erro));
  if (process.env.VERCEL) attachDatabasePool(pool);
  return { pool, db: criarDb(pool) };
}

// O cliente do processo nasce na primeira consulta: importar este módulo não exige variáveis.
let compartilhado: Cliente | undefined;

export function obterCliente(): Cliente {
  compartilhado ??= criarCliente();
  return compartilhado;
}

export const obterPool = () => obterCliente().pool;
export const obterDb = () => obterCliente().db;
