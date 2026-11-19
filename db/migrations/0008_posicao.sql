-- 0008 — posição de leitura: o Estudo que cada Estudante abriu por último, uma linha por Trilha.
-- Dado PRIVADO do Estudante: mora em `privado`, atrás de RLS forçada, com a mesma política `dono` da
-- Anotação (0001); só se chega a ela por `comEstudante`. Idempotente: pode ser aplicada de novo.

create table if not exists privado.posicao (
  estudante_id uuid not null references auth."user" (id) on delete cascade,
  trilha_id text not null references conteudo.trilha (id),
  estudo_id uuid not null references conteudo.estudo (id) on delete cascade,
  atualizado_em timestamptz not null default now(),
  primary key (estudante_id, trilha_id)
);

-- A chave estrangeira de `estudo_id` apaga a posição se o Estudo sair; o índice evita varrer a tabela.
create index if not exists posicao_estudo_idx on privado.posicao (estudo_id);

ALTER TABLE privado.posicao ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.posicao FORCE ROW LEVEL SECURITY;

drop policy if exists dono on privado.posicao;
create policy dono on privado.posicao
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);
