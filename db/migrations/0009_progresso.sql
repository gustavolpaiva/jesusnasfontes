-- 0009 — progresso de estudo: o que cada Estudante concluiu e em qual volta da Leitura contínua está.
-- Dado PRIVADO do Estudante: mora em `privado`, atrás de RLS forçada, com a mesma política `dono` da
-- Anotação (0001) e da posição (0008); só se chega a ele por `comEstudante`. Idempotente.
-- Esta migração é a 0009 e não a 0006 que o plano 01-13 previa: os números 0006 a 0008 já estavam em uso.

-- Uma conclusão por Estudante, Estudo e volta. Nada é apagado ao começar uma nova volta: a volta
-- anterior continua guardada com o seu número. Base histórica e Pontos centrais usam sempre a volta 1.
create table if not exists privado.conclusao (
  estudante_id uuid not null references auth."user" (id) on delete cascade,
  estudo_id uuid not null references conteudo.estudo (id) on delete cascade,
  volta smallint not null default 1 check (volta >= 1),
  concluido_em timestamptz not null default now(),
  primary key (estudante_id, estudo_id, volta)
);

-- A volta em que o Estudante está na Leitura contínua. Sem linha vale a volta 1.
create table if not exists privado.volta_leitura (
  estudante_id uuid primary key references auth."user" (id) on delete cascade,
  volta_atual smallint not null default 1 check (volta_atual >= 1),
  iniciada_em timestamptz not null default now()
);

-- A chave estrangeira de `estudo_id` apaga a conclusão se o Estudo sair; o índice evita varrer a tabela.
create index if not exists conclusao_estudo_idx on privado.conclusao (estudo_id);

ALTER TABLE privado.conclusao ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.conclusao FORCE ROW LEVEL SECURITY;
ALTER TABLE privado.volta_leitura ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.volta_leitura FORCE ROW LEVEL SECURITY;

drop policy if exists dono on privado.conclusao;
create policy dono on privado.conclusao
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);

drop policy if exists dono on privado.volta_leitura;
create policy dono on privado.volta_leitura
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);
