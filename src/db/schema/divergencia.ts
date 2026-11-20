import { pgSchema, primaryKey, smallint, text, unique, uuid } from "drizzle-orm/pg-core";
import { estudo } from "./conteudo";

// Declarações para o construtor de consultas. A fonte da verdade do esquema é db/migrations/*.sql.

const conteudo = pgSchema("conteudo");

export const divergencia = conteudo.table(
  "divergencia",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estudoId: uuid("estudo_id")
      .notNull()
      .references(() => estudo.id, { onDelete: "cascade" }),
    ordem: smallint("ordem").notNull(),
    tema: text("tema").notNull(),
  },
  (tabela) => [unique().on(tabela.estudoId, tabela.ordem)],
);

export const divergenciaLeitura = conteudo.table(
  "divergencia_leitura",
  {
    divergenciaId: uuid("divergencia_id")
      .notNull()
      .references(() => divergencia.id, { onDelete: "cascade" }),
    tradicao: text("tradicao").notNull(),
    resumo: text("resumo").notNull(),
  },
  (tabela) => [primaryKey({ columns: [tabela.divergenciaId, tabela.tradicao] })],
);

export const perguntaVolta = conteudo.table(
  "pergunta_volta",
  {
    conjunto: smallint("conjunto").notNull(),
    ordem: smallint("ordem").notNull(),
    texto: text("texto").notNull(),
  },
  (tabela) => [primaryKey({ columns: [tabela.conjunto, tabela.ordem] })],
);
