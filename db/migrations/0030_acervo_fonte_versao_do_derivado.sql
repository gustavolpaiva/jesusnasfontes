-- 0030 — Acervo: a Fonte guarda de QUAL versão do derivado ela foi carregada, para que um build de uma versão
-- ANTERIOR (redeploy ou rollback na Vercel) nunca leve o conteúdo para trás (plano 02-22, revisão cruzada).
-- Idempotente. Sem segredo. As migrações anteriores já estão aplicadas e não são editadas.
--
-- `derivado_revisao` é o número monótono que `data/acervo-derivados.lock.json` registra por derivado (sobe a cada
-- `acervo:derivar` que muda o arquivo) e `derivado_sha256`, o sha256 do arquivo carregado. A carga só grava a Fonte
-- se a revisão do build for igual ou maior que a do banco; menor, ela pula a Fonte com aviso. Fonte carregada antes
-- desta migração tem as duas colunas nulas: a carga a aceita e registra a revisão na primeira passagem.

alter table acervo.fonte add column if not exists derivado_revisao integer null;
alter table acervo.fonte add column if not exists derivado_sha256 text null;

alter table acervo.fonte drop constraint if exists fonte_derivado_revisao_valida;
alter table acervo.fonte add constraint fonte_derivado_revisao_valida
  check (derivado_revisao is null or derivado_revisao >= 1);

alter table acervo.fonte drop constraint if exists fonte_derivado_sha256_valido;
alter table acervo.fonte add constraint fonte_derivado_sha256_valido
  check (derivado_sha256 is null or derivado_sha256 ~ '^[0-9a-f]{64}$');

-- As duas colunas andam juntas: ou a Fonte tem o registro da versão carregada, ou não tem nenhum.
alter table acervo.fonte drop constraint if exists fonte_derivado_versao_junta;
alter table acervo.fonte add constraint fonte_derivado_versao_junta
  check ((derivado_revisao is null) = (derivado_sha256 is null));
