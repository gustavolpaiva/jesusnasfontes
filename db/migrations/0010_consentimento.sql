-- 0010 — consentimento: o aceite do aviso de privacidade, por Estudante e por versão do aviso.
-- Dado PRIVADO do Estudante: mora em `privado`, atrás de RLS forçada, com a mesma política `dono` da
-- Anotação (0001), da posição (0008) e do progresso (0009); só se chega a ele por `comEstudante`.
-- Idempotente: pode ser aplicada de novo.
-- Esta migração é a 0010 e não a 0007 que o plano 01-14 previa: os números 0007 a 0009 já estavam em uso.

-- Uma linha por aceite: mudar a versão do aviso não apaga o aceite anterior (continua como registro do
-- que a pessoa viu), e o Estudante precisa de uma linha da versão ATUAL para usar o app. `texto_hash` é
-- o sha256 do texto que foi mostrado.
create table if not exists privado.consentimento (
  estudante_id uuid not null references auth."user" (id) on delete cascade,
  versao_aviso text not null check (versao_aviso <> ''),
  texto_hash text not null check (texto_hash <> ''),
  aceito_em timestamptz not null default now(),
  primary key (estudante_id, versao_aviso)
);

ALTER TABLE privado.consentimento ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.consentimento FORCE ROW LEVEL SECURITY;

drop policy if exists dono on privado.consentimento;
create policy dono on privado.consentimento
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);
