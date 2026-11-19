import { bigint, boolean, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { autenticacao, usuario } from "./fundacao";

// Declarações para o Drizzle e para o adaptador do Better Auth. A fonte da verdade do esquema é
// db/migrations/*.sql. As chaves do objeto `esquemaAuth` são os nomes de modelo da biblioteca.

const administracao = pgSchema("admin");

const marcas = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const sessao = autenticacao.table("session", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usuario.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  ...marcas,
});

export const conta = autenticacao.table("account", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usuario.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  ...marcas,
});

export const verificacao = autenticacao.table("verification", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...marcas,
});

export const doisFatores = autenticacao.table("two_factor", {
  id: uuid("id").primaryKey().defaultRandom(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usuario.id, { onDelete: "cascade" }),
  verified: boolean("verified").default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

export const limiteDaBiblioteca = autenticacao.table("rate_limit", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const convite = administracao.table("convite", {
  id: uuid("id").primaryKey().defaultRandom(),
  emailNorm: text("email_norm").notNull().unique(),
  estado: text("estado").notNull(),
  criadoPor: uuid("criado_por").references(() => usuario.id, { onDelete: "set null" }),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  aceitoEm: timestamp("aceito_em", { withTimezone: true }),
  revogadoEm: timestamp("revogado_em", { withTimezone: true }),
});

export const sessaoMfa = administracao.table("sessao_mfa", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessao.id, { onDelete: "cascade" }),
  verificadoEm: timestamp("verificado_em", { withTimezone: true }).notNull().defaultNow(),
});

export const falhaSegundoFator = administracao.table("falha_segundo_fator", {
  sessionId: uuid("session_id")
    .primaryKey()
    .references(() => sessao.id, { onDelete: "cascade" }),
  falhas: integer("falhas").notNull().default(0),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
});

export const tentativa = administracao.table("tentativa", {
  chave: text("chave").primaryKey(),
  janelaInicio: timestamp("janela_inicio", { withTimezone: true }).notNull(),
  contagem: integer("contagem").notNull().default(0),
});

// Objeto de esquema do adaptador do Better Auth (nomes de modelo da biblioteca).
export const esquemaAuth = {
  user: usuario,
  session: sessao,
  account: conta,
  verification: verificacao,
  twoFactor: doisFatores,
  rateLimit: limiteDaBiblioteca,
};
