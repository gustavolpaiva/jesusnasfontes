-- 0012 — Sessão de estudo: o intervalo entre um check-in e um check-out, com o Estudo em que começou, o
-- Estudo em que parou e uma Anotação da Sessão opcional (TRIL-03, D-10).
-- Dado PRIVADO do Estudante: mora em `privado`, atrás de RLS forçada, com a mesma política `dono` da
-- Anotação (0001), da posição (0008), do progresso (0009) e do consentimento (0010); só se chega a ele por
-- `comEstudante`. Idempotente: pode ser aplicada de novo.
-- Esta migração é a 0012 e não a 0008 que o plano 01-16 previa: os números 0008 a 0011 já estavam em uso.

-- Uma linha por Sessão. `check_out_em` nulo é a Sessão aberta.
-- Os instantes vêm de `clock_timestamp()` no código (o instante real, já com a trava de progresso na mão),
-- não de `now()` (o início da transação): quem espera na fila não pode gravar um check-out ANTERIOR ao
-- check-in que acabou de enxergar.
-- Nenhuma restrição de verificação nesta tabela, de propósito: o banco repete a linha inteira na mensagem de
-- uma violação, e a linha carrega o texto da Anotação da Sessão. O limite de 200 caracteres é do servidor.
-- As chaves para o Estudo são em cascata, como as da Anotação, da posição e da conclusão: Estudo que sai do
-- conteúdo leva o que é privado dele.
create table if not exists privado.sessao (
  id uuid primary key default gen_random_uuid(),
  estudante_id uuid not null references auth."user" (id) on delete cascade,
  check_in_em timestamptz not null default clock_timestamp(),
  check_out_em timestamptz null,
  estudo_inicio_id uuid not null references conteudo.estudo (id) on delete cascade,
  estudo_fim_id uuid null references conteudo.estudo (id) on delete cascade,
  anotacao text null,
  tsv tsvector generated always as (to_tsvector('public.pt_unaccent', coalesce(anotacao, ''))) stored
);

-- Uma Sessão aberta por Estudante: a rede de segurança sob a trava de progresso.
create unique index if not exists sessao_uma_aberta_idx
  on privado.sessao (estudante_id) where check_out_em is null;

-- O histórico lê as mais recentes de cada Estudante.
create index if not exists sessao_historico_idx on privado.sessao (estudante_id, check_in_em desc);

-- A busca do Caderno (plano 01-18) procura na Anotação da Sessão.
create index if not exists sessao_tsv_gin on privado.sessao using gin (tsv);

-- As chaves para o Estudo apagam a Sessão se o Estudo sair; os índices evitam varrer a tabela.
create index if not exists sessao_estudo_inicio_idx on privado.sessao (estudo_inicio_id);
create index if not exists sessao_estudo_fim_idx on privado.sessao (estudo_fim_id);

ALTER TABLE privado.sessao ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.sessao FORCE ROW LEVEL SECURITY;

drop policy if exists dono on privado.sessao;
create policy dono on privado.sessao
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);
