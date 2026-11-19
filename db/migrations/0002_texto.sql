-- 0002 — texto bíblico, Estudos e o modelo vazio de Fonte, Afirmação e Citação.
-- O texto bíblico é dado público de referência: mora em `acervo`, nunca em `privado`. A carga de
-- texto e de conteúdo é papel do jnf_carga (privilégios padrão do bootstrap: DML em acervo e
-- conteudo; o jnf_carga não tem USAGE em privado nem em auth). Este arquivo não guarda segredo.
-- Idempotente: cada objeto nasce com IF NOT EXISTS.

-- Conjunto de dados de terceiros: versão, commit, licença e o selo do lock que o carregou.
create table if not exists acervo.conjunto_dados (
  id text primary key,
  nome text not null,
  versao text not null,
  commit text not null,
  licenca text not null,
  url_licenca text not null,
  sha256_lock text not null check (sha256_lock ~ '^[0-9a-f]{64}$'),
  edicao_exibida text null check (edicao_exibida in ('n4', 'tr')),
  carregado_em timestamptz not null default now()
);

create table if not exists acervo.livro (
  numero smallint primary key check (numero between 1 and 66),
  nome text not null,
  abreviacao text not null,
  capitulos smallint not null check (capitulos > 0)
);

-- A chave canônica é o inteiro BBCCCVVV (João 3:16 = 43003016); a ordem do inteiro é a ordem de
-- leitura, então toda Passagem é um BETWEEN. A coluna `id` tem de bater com livro, capítulo e número.
create table if not exists acervo.versiculo (
  id integer primary key,
  livro smallint not null references acervo.livro (numero),
  capitulo smallint not null check (capitulo > 0),
  numero smallint not null check (numero > 0),
  check (id = livro::integer * 1000000 + capitulo::integer * 1000 + numero::integer),
  unique (livro, capitulo, numero)
);

create table if not exists acervo.texto (
  id text primary key,
  conjunto_id text not null references acervo.conjunto_dados (id),
  edicao text not null check (edicao in ('n4', 'tr')),
  nome text not null,
  unique (conjunto_id, edicao)
);

create table if not exists acervo.texto_versiculo (
  texto_id text not null references acervo.texto (id),
  versiculo_id integer not null references acervo.versiculo (id),
  conteudo text not null,
  adicionados jsonb not null default '[]'::jsonb,
  notas jsonb not null default '[]'::jsonb,
  refs jsonb not null default '[]'::jsonb,
  titulo text null,
  duvidoso boolean not null default false,
  conteudo_hash text not null check (conteudo_hash ~ '^[0-9a-f]{64}$'),
  primary key (texto_id, versiculo_id)
);

-- Liga cada marcador do arquivo-fonte (por exemplo Mt.1.1) à chave. O versículo cujo texto o
-- arquivo traz dentro de outro (Mc 5:19, dentro de Mc.5.18) tem chave e marcador próprios aqui e
-- nenhuma linha em texto_versiculo.
create table if not exists acervo.correspondencia_versificacao (
  conjunto_id text not null references acervo.conjunto_dados (id),
  ref_externa text not null,
  versiculo_id integer null references acervo.versiculo (id),
  observacao text null,
  primary key (conjunto_id, ref_externa)
);

create index if not exists correspondencia_versiculo
  on acervo.correspondencia_versificacao (conjunto_id, versiculo_id);

-- Conteúdo escrito por nós: Trilhas, Estudos e as Passagens de cada Estudo (intervalos de chave).
create table if not exists conteudo.trilha (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  nome text not null,
  ordem smallint not null unique,
  descricao text not null
);

create table if not exists conteudo.estudo (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  trilha_id text not null references conteudo.trilha (id),
  ordem smallint not null,
  grupo text null,
  titulo text not null,
  recorte text not null check (recorte in ('historico', 'devocional')),
  minutos smallint null check (minutos > 0),
  corpo_md text not null,
  grau_certeza_valor text null
    check (grau_certeza_valor in ('consenso', 'posicao-majoritaria', 'disputada')),
  grau_certeza_texto text null,
  grau_certeza_revisado boolean not null default false,
  livro smallint null references acervo.livro (numero),
  capitulo smallint null check (capitulo > 0),
  conteudo_hash text not null check (conteudo_hash ~ '^[0-9a-f]{64}$'),
  atualizado_em timestamptz not null default now(),
  unique (trilha_id, ordem)
);

create table if not exists conteudo.estudo_passagem (
  estudo_id uuid not null references conteudo.estudo (id) on delete cascade,
  ordem smallint not null,
  versiculo_inicio integer not null references acervo.versiculo (id),
  versiculo_fim integer not null references acervo.versiculo (id),
  referencia_texto text not null,
  primary key (estudo_id, ordem),
  check (versiculo_inicio <= versiculo_fim)
);

-- Fonte, Afirmação e Citação (FUND-04): existem vazias, com identificadores estáveis, para a
-- Fase 2 pendurar Citações sem mudar o esquema.
create table if not exists acervo.fonte (
  id uuid primary key default gen_random_uuid(),
  nivel text not null check (nivel in ('primaria', 'academica', 'confessional')),
  titulo text not null,
  autor text null,
  data_publicacao date null,
  licenca text null,
  obra_protegida boolean not null default false,
  criada_em timestamptz not null default now()
);

create table if not exists acervo.fonte_secao (
  id text primary key,
  fonte_id uuid not null references acervo.fonte (id),
  ordem smallint not null,
  titulo text null,
  unique (fonte_id, ordem)
);

create table if not exists acervo.fonte_paragrafo (
  id text primary key,
  secao_id text not null references acervo.fonte_secao (id),
  ordem smallint not null,
  texto text not null,
  unique (secao_id, ordem)
);

create table if not exists acervo.afirmacao (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  estudo_id uuid null references conteudo.estudo (id) on delete restrict,
  texto text not null,
  texto_hash text not null check (texto_hash ~ '^[0-9a-f]{64}$'),
  ordem smallint null,
  grau_de_certeza text null
    check (grau_de_certeza in ('consenso', 'posicao-majoritaria', 'disputada'))
);

create table if not exists acervo.citacao (
  id uuid primary key default gen_random_uuid(),
  afirmacao_id text not null references acervo.afirmacao (id),
  fonte_paragrafo_id text not null references acervo.fonte_paragrafo (id),
  trecho text null,
  idioma text null,
  criada_em timestamptz not null default now()
);
