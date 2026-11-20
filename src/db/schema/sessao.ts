import { text, timestamp, uuid } from "drizzle-orm/pg-core";
import { estudo } from "./conteudo";
import { privado, usuario } from "./fundacao";

// Declaração para o construtor de consultas. A fonte da verdade é db/migrations/0012_sessao.sql
// (a coluna gerada `tsv`, da busca do Caderno, não é declarada: nada aqui a lê nem a escreve).

export const sessao = privado.table("sessao", {
  id: uuid("id").primaryKey().defaultRandom(),
  estudanteId: uuid("estudante_id")
    .notNull()
    .references(() => usuario.id, { onDelete: "cascade" }),
  checkInEm: timestamp("check_in_em", { withTimezone: true }).notNull().defaultNow(),
  checkOutEm: timestamp("check_out_em", { withTimezone: true }),
  estudoInicioId: uuid("estudo_inicio_id")
    .notNull()
    .references(() => estudo.id, { onDelete: "cascade" }),
  estudoFimId: uuid("estudo_fim_id").references(() => estudo.id, { onDelete: "cascade" }),
  anotacao: text("anotacao"),
});
