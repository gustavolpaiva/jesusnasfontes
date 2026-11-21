import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { estudo } from "./conteudo";

// Declarações para o construtor de consultas. A fonte da verdade do esquema é db/migrations/*.sql.

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const acervo = pgSchema("acervo");
export const autenticacao = pgSchema("auth");
export const privado = pgSchema("privado");

export const ambiente = acervo.table("ambiente", {
  id: boolean("id").primaryKey().default(true),
  nome: text("nome").notNull(),
});

export const usuario = autenticacao.table("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().default(""),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  role: text("role").notNull().default("estudante"),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
});

export const anotacao = privado.table(
  "anotacao",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estudanteId: uuid("estudante_id")
      .notNull()
      .references(() => usuario.id, { onDelete: "cascade" }),
    // `on delete restrict` (0013): um Estudo com Anotação não sai do conteúdo calado.
    estudoId: uuid("estudo_id")
      .notNull()
      .references(() => estudo.id, { onDelete: "restrict" }),
    corpo: text("corpo").notNull(),
    versao: integer("versao").notNull().default(1),
    // 0014: o escritor (montagem do editor) que gravou por último. A ordem dos envios está em
    // `anotacaoEscritor` (0015). Ver o núcleo.
    montagem: uuid("montagem"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('public.pt_unaccent', corpo)`),
  },
  (tabela) => [unique().on(tabela.estudanteId, tabela.estudoId)],
);

// 0015: um escritor (montagem do editor) por linha, sem Estudo, sem texto e sem data: o número do último envio
// dele que o servidor processou e, se o último ato dele foi apagar a Anotação, o id da linha apagada.
export const anotacaoEscritor = privado.table(
  "anotacao_escritor",
  {
    estudanteId: uuid("estudante_id")
      .notNull()
      .references(() => usuario.id, { onDelete: "cascade" }),
    montagem: uuid("montagem").notNull(),
    seq: integer("seq").notNull(),
    apagou: uuid("apagou"),
  },
  (tabela) => [primaryKey({ columns: [tabela.estudanteId, tabela.montagem] })],
);
