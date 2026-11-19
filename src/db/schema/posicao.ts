import { primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { estudo, trilha } from "./conteudo";
import { privado, usuario } from "./fundacao";

// Declaração para o construtor de consultas. A fonte da verdade é db/migrations/0008_posicao.sql.

export const posicao = privado.table(
  "posicao",
  {
    estudanteId: uuid("estudante_id")
      .notNull()
      .references(() => usuario.id, { onDelete: "cascade" }),
    trilhaId: text("trilha_id")
      .notNull()
      .references(() => trilha.id),
    estudoId: uuid("estudo_id")
      .notNull()
      .references(() => estudo.id, { onDelete: "cascade" }),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (tabela) => [primaryKey({ columns: [tabela.estudanteId, tabela.trilhaId] })],
);
