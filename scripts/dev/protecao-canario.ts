import type pg from "pg";
import { lerEmail, normalizarEmail } from "../../src/modules/identidade/normalizar-email";
import type { Papel } from "./canario";
import { conferirAmbienteDev } from "./conferir-entrada";

// Proteção de toda escrita que mexe em conta canário (plano 01-19). Uma conta só é tratada como canário
// quando as três coisas valem JUNTAS, e a conferência roda ANTES de cada escrita, no começo e no fim:
//
//   1. o banco é o de dev (marcador `acervo.ambiente`), lido pela MESMA conexão que vai escrever;
//   2. o endereço é o da variável do papel (JNF_CANARIO_ESTUDANTE_EMAIL ou JNF_CANARIO_ADMIN_EMAIL), ou
//      seja, foi marcado como canário no cofre, por nome; endereço qualquer não é canário;
//   3. não é o Admin inicial (por endereço e por id) e, se a conta já existe, o papel dela é o do canário.
//
// Sem ADMIN_EMAIL_INICIAL no ambiente não há como provar o item 3: recusa (nunca "sem prova, segue").

export class RecusaCanario extends Error {
  override name = "RecusaCanario";
}

type Cliente = Pick<pg.Pool, "query">;

const VARIAVEL_DO_PAPEL: Record<Papel, string> = {
  estudante: "JNF_CANARIO_ESTUDANTE_EMAIL",
  admin: "JNF_CANARIO_ADMIN_EMAIL",
};

export function emailDoCanario(papel: Papel): string | null {
  return lerEmail(process.env[VARIAVEL_DO_PAPEL[papel]]);
}

// Devolve o id da conta (ou null se ela ainda não existe). Lança antes de qualquer escrita.
export async function conferirContaCanario(
  c: Cliente,
  emailBruto: string,
  papel?: Papel,
): Promise<{ usuarioId: string | null }> {
  await conferirAmbienteDev(c);
  const email = normalizarEmail(emailBruto);
  const papeis: Papel[] = papel ? [papel] : ["estudante", "admin"];
  if (!papeis.some((p) => emailDoCanario(p) === email)) {
    throw new RecusaCanario(
      "RecusaDeConta: o endereço não é o de um canário marcado no cofre; nada foi alterado.",
    );
  }
  if (
    emailDoCanario("estudante") !== null &&
    emailDoCanario("estudante") === emailDoCanario("admin")
  ) {
    throw new RecusaCanario("RecusaDeConta: os dois canários têm o mesmo endereço.");
  }
  const real = lerEmail(process.env.ADMIN_EMAIL_INICIAL);
  if (!real) {
    throw new RecusaCanario(
      "INDETERMINADO: ADMIN_EMAIL_INICIAL ausente; sem ele não se prova que o canário não é a conta real.",
    );
  }
  if (email === real) {
    throw new RecusaCanario("RecusaDeConta: o canário é o Admin inicial; nada foi alterado.");
  }
  const conta = await c.query<{ id: string; role: string }>(
    'select id::text as id, role from auth."user" where email = $1',
    [email],
  );
  const dono = await c.query<{ id: string }>(
    'select id::text as id from auth."user" where email = $1',
    [real],
  );
  const id = conta.rows[0]?.id ?? null;
  if (id !== null && id === dono.rows[0]?.id) {
    throw new RecusaCanario("RecusaDeConta: a conta é a do Admin inicial; nada foi alterado.");
  }
  if (papel && conta.rows[0] && conta.rows[0].role !== papel) {
    throw new RecusaCanario(
      "RecusaDeConta: o papel da conta não é o do canário; nada foi alterado.",
    );
  }
  return { usuarioId: id };
}
