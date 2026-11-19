import {
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { estudo } from "./conteudo";

// Declarações para o construtor de consultas. A fonte da verdade do esquema é db/migrations/*.sql.
// O texto bíblico é dado público de referência: fica em `acervo`, nunca em `privado`.

export const acervo = pgSchema("acervo");

export const conjuntoDados = acervo.table("conjunto_dados", {
  id: text("id").primaryKey(),
  nome: text("nome").notNull(),
  versao: text("versao").notNull(),
  commit: text("commit").notNull(),
  licenca: text("licenca").notNull(),
  urlLicenca: text("url_licenca").notNull(),
  sha256Lock: text("sha256_lock").notNull(),
  edicaoExibida: text("edicao_exibida"),
  carregadoEm: timestamp("carregado_em", { withTimezone: true }).notNull().defaultNow(),
});

export const livro = acervo.table("livro", {
  numero: smallint("numero").primaryKey(),
  nome: text("nome").notNull(),
  abreviacao: text("abreviacao").notNull(),
  capitulos: smallint("capitulos").notNull(),
});

export const versiculo = acervo.table(
  "versiculo",
  {
    id: integer("id").primaryKey(),
    livro: smallint("livro")
      .notNull()
      .references(() => livro.numero),
    capitulo: smallint("capitulo").notNull(),
    numero: smallint("numero").notNull(),
  },
  (tabela) => [unique().on(tabela.livro, tabela.capitulo, tabela.numero)],
);

export const texto = acervo.table(
  "texto",
  {
    id: text("id").primaryKey(),
    conjuntoId: text("conjunto_id")
      .notNull()
      .references(() => conjuntoDados.id),
    edicao: text("edicao").notNull(),
    nome: text("nome").notNull(),
  },
  (tabela) => [unique().on(tabela.conjuntoId, tabela.edicao)],
);

export const textoVersiculo = acervo.table(
  "texto_versiculo",
  {
    textoId: text("texto_id")
      .notNull()
      .references(() => texto.id),
    versiculoId: integer("versiculo_id")
      .notNull()
      .references(() => versiculo.id),
    conteudo: text("conteudo").notNull(),
    adicionados: jsonb("adicionados").notNull().default([]),
    notas: jsonb("notas").notNull().default([]),
    refs: jsonb("refs").notNull().default([]),
    titulo: text("titulo"),
    duvidoso: boolean("duvidoso").notNull().default(false),
    conteudoHash: text("conteudo_hash").notNull(),
  },
  (tabela) => [primaryKey({ columns: [tabela.textoId, tabela.versiculoId] })],
);

export const correspondenciaVersificacao = acervo.table(
  "correspondencia_versificacao",
  {
    conjuntoId: text("conjunto_id")
      .notNull()
      .references(() => conjuntoDados.id),
    refExterna: text("ref_externa").notNull(),
    versiculoId: integer("versiculo_id").references(() => versiculo.id),
    observacao: text("observacao"),
  },
  (tabela) => [primaryKey({ columns: [tabela.conjuntoId, tabela.refExterna] })],
);

export const fonte = acervo.table("fonte", {
  id: uuid("id").primaryKey().defaultRandom(),
  nivel: text("nivel").notNull(),
  titulo: text("titulo").notNull(),
  autor: text("autor"),
  dataPublicacao: date("data_publicacao"),
  licenca: text("licenca"),
  obraProtegida: boolean("obra_protegida").notNull().default(false),
  criadaEm: timestamp("criada_em", { withTimezone: true }).notNull().defaultNow(),
});

export const fonteSecao = acervo.table(
  "fonte_secao",
  {
    id: text("id").primaryKey(),
    fonteId: uuid("fonte_id")
      .notNull()
      .references(() => fonte.id),
    ordem: smallint("ordem").notNull(),
    titulo: text("titulo"),
  },
  (tabela) => [unique().on(tabela.fonteId, tabela.ordem)],
);

export const fonteParagrafo = acervo.table(
  "fonte_paragrafo",
  {
    id: text("id").primaryKey(),
    secaoId: text("secao_id")
      .notNull()
      .references(() => fonteSecao.id),
    ordem: smallint("ordem").notNull(),
    texto: text("texto").notNull(),
  },
  (tabela) => [unique().on(tabela.secaoId, tabela.ordem)],
);

export const afirmacao = acervo.table("afirmacao", {
  id: text("id").primaryKey(),
  estudoId: uuid("estudo_id").references(() => estudo.id, { onDelete: "restrict" }),
  texto: text("texto").notNull(),
  textoHash: text("texto_hash").notNull(),
  ordem: smallint("ordem"),
  grauDeCerteza: text("grau_de_certeza"),
});

export const citacao = acervo.table("citacao", {
  id: uuid("id").primaryKey().defaultRandom(),
  afirmacaoId: text("afirmacao_id")
    .notNull()
    .references(() => afirmacao.id),
  fonteParagrafoId: text("fonte_paragrafo_id")
    .notNull()
    .references(() => fonteParagrafo.id),
  trecho: text("trecho"),
  idioma: text("idioma"),
  criadaEm: timestamp("criada_em", { withTimezone: true }).notNull().defaultNow(),
});
