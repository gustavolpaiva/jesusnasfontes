-- 0006 — geração do segundo fator por conta. A recuperação sobe a geração na mesma transação que
-- apaga o segundo fator; toda conferência que começou antes e termina depois lê uma geração
-- diferente da atual e não concede nada. A marca de "sessão verificada" guarda a geração em que
-- foi dada e só vale enquanto for a atual. Sem linha = geração 0. Idempotente. Sem segredo algum.
create table if not exists admin.segundo_fator_geracao (
  user_id uuid primary key references auth."user" (id) on delete cascade,
  geracao integer not null default 0
);

alter table admin.sessao_mfa add column if not exists geracao integer not null default 0;
