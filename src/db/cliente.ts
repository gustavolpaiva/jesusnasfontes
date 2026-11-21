import { attachDatabasePool } from "@vercel/functions";
import { drizzle, NodePgSession } from "drizzle-orm/node-postgres";
import { PgPreparedQuery } from "drizzle-orm/pg-core";
import pg from "pg";
import { registrarErro } from "@/lib/registro";
import { decidirAmbiente } from "./decidir-ambiente";
import { sanitizarErroDeBanco } from "./erro-banco";
import { urlDoPapel } from "./url";

// O Drizzle embrulha toda falha de consulta num erro com a consulta e os parâmetros (e põe os
// parâmetros na própria mensagem). Para nada disso sair da camada de banco, a execução de consulta
// e a abertura de transação passam por `sanitizarErroDeBanco`: sai um ErroDeBanco só com o código
// SQLSTATE e o nome da restrição. Erros do nosso código (lançados dentro de uma transação) passam
// intactos. Aplicado uma vez por processo.
const MARCA = Symbol.for("jnf.erro-banco-sanitizado");
type Protegivel = Record<string | symbol, unknown>;

function proteger(prototipo: object, metodo: string): void {
  const alvo = prototipo as Protegivel;
  const original = alvo[metodo] as (this: unknown, ...a: unknown[]) => Promise<unknown>;
  alvo[metodo] = async function (this: unknown, ...argumentos: unknown[]) {
    try {
      return await original.apply(this, argumentos);
    } catch (erro) {
      throw sanitizarErroDeBanco(erro);
    }
  };
}

if (!(PgPreparedQuery.prototype as unknown as Protegivel)[MARCA]) {
  proteger(PgPreparedQuery.prototype, "queryWithCache");
  proteger(NodePgSession.prototype, "transaction");
  (PgPreparedQuery.prototype as unknown as Protegivel)[MARCA] = true;
}

export type Cliente = { pool: pg.Pool; db: ReturnType<typeof criarDb> };

function criarDb(pool: pg.Pool) {
  // Sem logger: o log de consultas do Drizzle imprimiria parâmetros, e entre eles o texto da Anotação.
  return drizzle(pool);
}

type RetornoDeConexao = (
  erro: Error | undefined,
  cliente: pg.PoolClient | undefined,
  liberar: (descartar?: boolean | Error) => void,
) => void;

// O par ambiente × banco é conferido na CONEXÃO, a única passagem de toda consulta: a entrada por convite e a biblioteca
// de autenticação usam `obterDb` direto e nunca passavam pelas portas (`comAcervo`, `comEstudante`), então um Preview com
// credencial de produção gravava contadores e códigos antes de qualquer porta recusar. O marcador é lido uma vez por
// processo, numa conexão própria; o par é decidido a cada conexão (a variável da Vercel é a de agora).
class PoolConferido extends pg.Pool {
  #marcador: Promise<string> | undefined;

  #lerMarcador(): Promise<string> {
    this.#marcador ??= (async () => {
      const cliente = await super.connect();
      try {
        const r = await cliente.query<{ nome: string }>("select nome from acervo.ambiente");
        const nome = r.rows[0]?.nome;
        if (r.rows.length !== 1 || !nome) {
          throw new Error("Marcador de ambiente ausente no banco: rode as migrações.");
        }
        return nome;
      } finally {
        cliente.release();
      }
    })().catch((erro) => {
      this.#marcador = undefined; // falha não é memoizada
      throw erro;
    });
    return this.#marcador;
  }

  async #conferir(): Promise<void> {
    decidirAmbiente(await this.#lerMarcador(), process.env.VERCEL_ENV);
  }

  override connect(): Promise<pg.PoolClient>;
  override connect(retorno: RetornoDeConexao): void;
  override connect(retorno?: RetornoDeConexao): Promise<pg.PoolClient> | undefined {
    const conferida = this.#conferir();
    if (retorno) {
      conferida.then(
        () => super.connect(retorno),
        (erro: Error) => retorno(erro, undefined, () => undefined),
      );
      return;
    }
    return conferida.then(() => super.connect());
  }
}

// Pool do papel jnf_app pela URL agrupada. `max` pequeno: o agrupador do Neon faz o resto.
export function criarCliente(opcoes: { max: number } = { max: 5 }): Cliente {
  const pool = new PoolConferido({
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
