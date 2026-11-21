-- 0015 — Anotação: apagar o texto volta a APAGAR a linha, e a ordem dos envios sai dela (plano 01-18, revisão
-- da rodada 11). Idempotente: pode ser aplicada de novo.
--
-- Na 0014 a ordem (o escritor e o número do último envio) morava na linha da Anotação, e apagar o texto
-- deixava a linha com o corpo vazio para não perder a ordem: o servidor seguia guardando que houve uma
-- Anotação naquele Estudo, e as datas. Aqui a ordem vai para `privado.anotacao_escritor`, uma linha por
-- ESCRITOR (a montagem do editor), sem Estudo, sem texto e sem data: o id aleatório do escritor, o número do
-- último envio dele que o servidor processou e, se o último ato dele foi apagar a Anotação, o id da linha que
-- ele apagou (para continuar o que ele mesmo fez). Apagar a conta leva tudo (cascata); exportar a traz pelo
-- catálogo, como toda tabela de `privado`.
--
-- A linha da Anotação guarda só QUEM gravou por último (`montagem`), enquanto existe.

create table if not exists privado.anotacao_escritor (
  estudante_id uuid not null references auth."user" (id) on delete cascade,
  montagem uuid not null,
  seq integer not null,
  apagou uuid null,
  primary key (estudante_id, montagem)
);

ALTER TABLE privado.anotacao_escritor ENABLE ROW LEVEL SECURITY;
ALTER TABLE privado.anotacao_escritor FORCE ROW LEVEL SECURITY;

drop policy if exists dono on privado.anotacao_escritor;
create policy dono on privado.anotacao_escritor
  for all
  using (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid)
  with check (estudante_id = nullif(current_setting('app.estudante_id', true), '')::uuid);

-- Linhas de corpo vazio da 0014: nenhuma foi escrita (a 0014 viveu minutos no banco de desenvolvimento, sem
-- uso do site). Não há `delete` aqui de propósito: com a RLS forçada, a migração não veria as linhas.
alter table privado.anotacao drop column if exists seq;
