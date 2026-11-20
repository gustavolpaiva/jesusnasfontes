import { primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { privado, usuario } from "./fundacao";

// Declaração para o construtor de consultas. A fonte da verdade é db/migrations/0010_consentimento.sql.

export const consentimento = privado.table(
  "consentimento",
  {
    estudanteId: uuid("estudante_id")
      .notNull()
      .references(() => usuario.id, { onDelete: "cascade" }),
    versaoAviso: text("versao_aviso").notNull(),
    textoHash: text("texto_hash").notNull(),
    aceitoEm: timestamp("aceito_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (tabela) => [primaryKey({ columns: [tabela.estudanteId, tabela.versaoAviso] })],
);
