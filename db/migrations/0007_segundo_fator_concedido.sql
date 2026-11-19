-- 0007 — "o segundo fator foi ativado" passa a ser um FATO GRAVADO por geração, em vez de derivado de
-- sessões verificadas (que somem no logout, na expiração e no encerramento pela guarda). A concessão
-- grava `concedido_em` na linha de geração da conta, sob a mesma trava e na mesma transação que grava
-- a marca da sessão; só a recuperação pelo dono o limpa (a geração nova nasce sem concessão).
-- Contas que já têm sessão verificada na geração atual nascem com o fato gravado. Idempotente.
alter table admin.segundo_fator_geracao add column if not exists concedido_em timestamptz;

insert into admin.segundo_fator_geracao (user_id, geracao, concedido_em)
select s.user_id, coalesce(g.geracao, 0), now()
from admin.sessao_mfa m
join auth.session s on s.id = m.session_id
left join admin.segundo_fator_geracao g on g.user_id = s.user_id
where m.geracao = coalesce(g.geracao, 0)
group by s.user_id, g.geracao
on conflict (user_id) do update
  set concedido_em = coalesce(admin.segundo_fator_geracao.concedido_em, excluded.concedido_em);
