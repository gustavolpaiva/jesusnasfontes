-- 0027 — Acervo: a Fonte ganha `editor`, à parte do `tradutor` (ACER-04). Idempotente. Sem segredo.
--
-- O defeito: nos volumes do CCEL (Ante-Nicene Fathers, NPNF, Lightfoot) o cabeçalho nomeia o EDITOR do volume
-- (Philip Schaff, Allan Menzies...) e o YAML punha esse nome em `tradutor`, de modo que a proveniência pública
-- creditava a pessoa errada. `tradutor` passa a ser só quem traduziu ESTA obra (e pode faltar: a página diz "tradutor
-- não identificado na edição"); o editor do volume ou da coleção tem coluna própria e aparece separado.
-- Coluna anulável, sem valor padrão: nenhuma linha existente muda, e as funções do painel (0022 e 0023) seguem
-- gravando sem ela.

alter table acervo.fonte add column if not exists editor text null;
