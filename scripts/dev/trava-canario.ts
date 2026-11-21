import { createHash } from "node:crypto";
import type pg from "pg";
import { conferirAmbienteDev } from "./conferir-entrada";
import { RecusaCanario } from "./protecao-canario";

// Trava de uma execução por conta canário (plano 01-19): advisory lock do Postgres, de SESSÃO, tomado na
// preparação e solto depois da limpeza. Precisa de uma conexão DEDICADA e direta, mantida aberta durante
// toda a execução (o lock morre com a conexão; conexão agrupada em modo transação não serve). A chave
// vem do endereço normalizado do canário (a conta pode ainda não existir quando a trava é tomada).

export class OutraExecucao extends RecusaCanario {
  override name = "OutraExecucao";
}

type Cliente = Pick<pg.Client, "query">;

// Chave bigint estável e própria deste uso.
function chaveDe(emailNorm: string): string {
  const h = createHash("sha256").update(`jnf-canario:${emailNorm}`).digest();
  return h.readBigInt64BE(0).toString();
}

export async function tomarTrava(c: Cliente, emailNorm: string): Promise<void> {
  await conferirAmbienteDev(c);
  const r = await c.query<{ ok: boolean }>("select pg_try_advisory_lock($1::bigint) as ok", [
    chaveDe(emailNorm),
  ]);
  if (r.rows[0]?.ok !== true) {
    throw new OutraExecucao(
      "OutraExecucao: já há uma execução usando esta conta canário; esta recusa sem escrever.",
    );
  }
}

// Confere, no catálogo de locks, que ESTA sessão ainda segura a trava (a conexão pode ter caído).
export async function travaViva(c: Cliente, emailNorm: string): Promise<boolean> {
  const r = await c.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid() and granted
       and objsubid = 1
       and classid::bigint = (($1::bigint >> 32) & 4294967295)
       and objid::bigint = ($1::bigint & 4294967295)`,
    [chaveDe(emailNorm)],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

export async function soltarTrava(c: Cliente, emailNorm: string): Promise<void> {
  await c.query("select pg_advisory_unlock($1::bigint)", [chaveDe(emailNorm)]);
}
