import { integer, pgSchema, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usuario } from "./fundacao";
import { acervo, fonte } from "./texto";

// Declarações para o construtor de consultas. A fonte da verdade é db/migrations/0017_acervo_ficha.sql.
// As tabelas de evidência (conferência e verificação) não têm escrita para o aplicativo: só as funções
// do banco gravam nelas; as declarações servem para ler.

const administracao = pgSchema("admin");

/** A ficha de uma obra protegida: 1:1 com uma `fonte` de `tipo_texto` 'ficha'. */
export const ficha = acervo.table("ficha", {
  fonteId: uuid("fonte_id")
    .primaryKey()
    .references(() => fonte.id),
  edicaoConsultada: text("edicao_consultada").notNull(),
  ano: smallint("ano"),
  editora: text("editora"),
  tesePt: text("tese_pt").notNull(),
  origemDoRascunho: text("origem_do_rascunho").notNull(),
  idiomaTrechos: text("idioma_trechos").notNull(),
  conteudoHash: text("conteudo_hash").notNull(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
});

/** Argumento ou trecho de uma ficha; todo item tem página. O id é `<slug>/<tipo>-<n>`. */
export const fichaItem = acervo.table("ficha_item", {
  id: text("id").primaryKey(),
  fichaId: uuid("ficha_id")
    .notNull()
    .references(() => ficha.fonteId, { onDelete: "cascade" }),
  tipo: text("tipo").notNull(),
  ordem: smallint("ordem").notNull(),
  textoPt: text("texto_pt").notNull(),
  paginaInicio: integer("pagina_inicio"),
  paginaFim: integer("pagina_fim"),
  paginaTexto: text("pagina_texto"),
  trechoOriginal: text("trecho_original"),
  idiomaTrecho: text("idioma_trecho"),
  confianca: text("confianca").notNull(),
  conteudoHash: text("conteudo_hash").notNull(),
});

/** Evidência: o Admin conferiu esta página no livro, para ESTE hash do item. */
export const conferenciaItem = acervo.table("conferencia_item", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => fichaItem.id, { onDelete: "cascade" }),
  itemHash: text("item_hash").notNull(),
  conferidaEm: timestamp("conferida_em", { withTimezone: true }).notNull().defaultNow(),
});

/** Evidência: a ficha foi verificada para ESTE hash. Sem linha ou com hash velho, é rascunho. */
export const verificacaoFicha = acervo.table("verificacao_ficha", {
  fichaId: uuid("ficha_id")
    .primaryKey()
    .references(() => ficha.fonteId, { onDelete: "cascade" }),
  fichaHash: text("ficha_hash").notNull(),
  verificadaEm: timestamp("verificada_em", { withTimezone: true }).notNull().defaultNow(),
});

/** O nome de quem agiu mora só aqui (D-05); o Estudante nunca lê este esquema. */
export const registroVerificacao = administracao.table("registro_verificacao", {
  id: uuid("id").primaryKey().defaultRandom(),
  acao: text("acao").notNull(),
  alvo: text("alvo").notNull(),
  hash: text("hash").notNull(),
  por: uuid("por").references(() => usuario.id, { onDelete: "set null" }),
  em: timestamp("em", { withTimezone: true }).notNull().defaultNow(),
});
