import {
  boolean,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { livro, versiculo } from "./texto";

// Declarações para o construtor de consultas. A fonte da verdade do esquema é db/migrations/*.sql.

export const conteudo = pgSchema("conteudo");

export const trilha = conteudo.table("trilha", {
  id: text("id").primaryKey(),
  nome: text("nome").notNull(),
  ordem: smallint("ordem").notNull().unique(),
  descricao: text("descricao").notNull(),
});

export const estudo = conteudo.table(
  "estudo",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    trilhaId: text("trilha_id")
      .notNull()
      .references(() => trilha.id),
    ordem: smallint("ordem").notNull(),
    grupo: text("grupo"),
    titulo: text("titulo").notNull(),
    recorte: text("recorte").notNull(),
    minutos: smallint("minutos"),
    corpoMd: text("corpo_md").notNull(),
    grauCertezaValor: text("grau_certeza_valor"),
    grauCertezaTexto: text("grau_certeza_texto"),
    grauCertezaRevisado: boolean("grau_certeza_revisado").notNull().default(false),
    livro: smallint("livro").references(() => livro.numero),
    capitulo: smallint("capitulo"),
    conteudoHash: text("conteudo_hash").notNull(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (tabela) => [unique().on(tabela.trilhaId, tabela.ordem)],
);

export const estudoPassagem = conteudo.table(
  "estudo_passagem",
  {
    estudoId: uuid("estudo_id")
      .notNull()
      .references(() => estudo.id, { onDelete: "cascade" }),
    ordem: smallint("ordem").notNull(),
    versiculoInicio: integer("versiculo_inicio")
      .notNull()
      .references(() => versiculo.id),
    versiculoFim: integer("versiculo_fim")
      .notNull()
      .references(() => versiculo.id),
    referenciaTexto: text("referencia_texto").notNull(),
  },
  (tabela) => [primaryKey({ columns: [tabela.estudoId, tabela.ordem] })],
);
