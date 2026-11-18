-- 0003 — entrada por convite: sessões e verificações do Better Auth, convites do Admin e limites.
-- Os ids são uuid. As tabelas de `auth` guardam dados de conta; nada daqui é privado por Estudante
-- (a Anotação continua isolada em `privado.*`). Sem segredo algum neste arquivo.

create table auth.session (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth."user" (id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  ip_address text,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index session_user_id on auth.session (user_id);

create table auth.account (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  provider_id text not null,
  user_id uuid not null references auth."user" (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index account_user_id on auth.account (user_id);

-- `identifier` não é único por desenho da biblioteca (o código de 6 dígitos é recriado a cada erro).
create table auth.verification (
  id uuid primary key default gen_random_uuid(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index verification_identifier on auth.verification (identifier);

create table auth.two_factor (
  id uuid primary key default gen_random_uuid(),
  secret text not null,
  backup_codes text not null,
  user_id uuid not null references auth."user" (id) on delete cascade,
  verified boolean default true,
  failed_verification_count integer default 0,
  locked_until timestamptz
);
create index two_factor_user_id on auth.two_factor (user_id);

create table auth.rate_limit (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  count integer not null,
  last_request bigint not null
);

create table admin.convite (
  id uuid primary key default gen_random_uuid(),
  email_norm text not null unique,
  estado text not null check (estado in ('pendente', 'aceito', 'revogado')),
  criado_por uuid references auth."user" (id) on delete set null,
  criado_em timestamptz not null default now(),
  aceito_em timestamptz,
  revogado_em timestamptz
);

create table admin.sessao_mfa (
  session_id uuid primary key references auth.session (id) on delete cascade,
  verificado_em timestamptz not null default now()
);

create table admin.falha_segundo_fator (
  session_id uuid primary key references auth.session (id) on delete cascade,
  falhas integer not null default 0,
  atualizado_em timestamptz not null default now()
);

-- Contador de janela fixa para os limites de pedido e de código.
create table admin.tentativa (
  chave text not null,
  janela_inicio timestamptz not null,
  contagem integer not null default 0,
  primary key (chave, janela_inicio)
);
