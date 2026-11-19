import { primaryKey, smallint, timestamp, uuid } from "drizzle-orm/pg-core";
import { estudo } from "./conteudo";
import { privado, usuario } from "./fundacao";

// Declarações para o construtor de consultas. A fonte da verdade é db/migrations/0009_progresso.sql.

export const conclusao = privado.table(
  "conclusao",
  {
    estudanteId: uuid("estudante_id")
      .notNull()
      .references(() => usuario.id, { onDelete: "cascade" }),
    estudoId: uuid("estudo_id")
      .notNull()
      .references(() => estudo.id, { onDelete: "cascade" }),
    volta: smallint("volta").notNull().default(1),
    concluidoEm: timestamp("concluido_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (tabela) => [primaryKey({ columns: [tabela.estudanteId, tabela.estudoId, tabela.volta] })],
);

export const voltaLeitura = privado.table("volta_leitura", {
  estudanteId: uuid("estudante_id")
    .primaryKey()
    .references(() => usuario.id, { onDelete: "cascade" }),
  voltaAtual: smallint("volta_atual").notNull().default(1),
  iniciadaEm: timestamp("iniciada_em", { withTimezone: true }).notNull().defaultNow(),
});
