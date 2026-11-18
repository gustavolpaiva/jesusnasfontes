-- 0001 — fundação: marcador de ambiente, contas e Anotação privada.
-- Esquemas, papéis e extensões vêm do bootstrap (scripts/db/bootstrap-papeis.ts); este arquivo não
-- guarda segredo algum. Os privilégios chegam por ALTER DEFAULT PRIVILEGES do bootstrap.

-- Uma linha só: a chave booleana só aceita verdadeiro.
create table acervo.ambiente (
  id boolean primary key default true check (id),
  nome text not null check (nome in ('dev', 'producao'))
);

create table auth."user" (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  email text not null unique,
  email_verified boolean not null default false,
  image text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  role text not null default 'estudante' check (role in ('estudante', 'admin')),
  two_factor_enabled boolean not null default false
);

create table privado.anotacao (
  id uuid primary key default gen_random_uuid(),
  estudante_id uuid not null references auth."user" (id) on delete cascade,
  estudo_id uuid not null,
  corpo text not null,
  versao integer not null default 1,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('public.pt_unaccent', corpo)) stored,
  unique (estudante_id, estudo_id)
);

create index anotacao_tsv_gin on privado.anotacao using gin (tsv);

ALTER TABLE privado.anotacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.anotacao FORCE ROW LEVEL SECURITY;

create policy dono on privado.anotacao
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);
