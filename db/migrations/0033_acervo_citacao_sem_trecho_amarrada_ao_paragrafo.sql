-- 0033 — Acervo: a Citação de parágrafo SEM trecho fica amarrada ao texto do parágrafo (plano 02-24, terceira passada da revisão
-- cruzada, ALTA). Idempotente. Sem segredo. A 0032 já está aplicada e não é editada.
--
-- Citação de parágrafo com `trecho` nulo cita o parágrafo INTEIRO: a tela o mostra como citação aprovada (`citacoes.ts`). A 0032 exigiu
-- que o trecho gravado continue no parágrafo, mas com `trecho` nulo não há o que conferir, e um texto de parágrafo mudado depois da
-- aprovação passava a ser mostrado como se o Admin o tivesse visto. O hash do conjunto de Citações (`acervo.hash_citacoes`) passa a
-- incluir, para a Citação de parágrafo sem trecho, o sha256 do texto ATUAL do parágrafo: mudou o parágrafo, mudou o hash, e a
-- aprovação (`aprovacao_vale`, que compara o hash gravado com o de agora) deixa de valer sozinha, sem apagar nada, como acontece com o
-- texto da Afirmação e com o conjunto de Citações. O hash das demais Citações não muda (nenhuma aprovação existente é invalidada por isto:
-- nenhuma Afirmação está aprovada em nenhum banco até esta data).

create or replace function acervo.hash_citacoes(p_afirmacao text) returns text
language sql stable security definer
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to(
    '["jnf-citacoes-v1",'
    || coalesce(string_agg(
         '[' || c.ordem::text || ','
             || acervo.json_de_texto(
                  case
                    when c.fonte_paragrafo_id is not null then 'p:' || c.fonte_paragrafo_id
                    when c.ficha_item_id is not null then 'i:' || c.ficha_item_id
                    else 'v:' || c.versiculo_inicio::text || '-' || c.versiculo_fim::text
                  end) || ','
             || acervo.json_de_texto(
                  case
                    when c.fonte_paragrafo_id is not null and c.trecho is null
                      then 'texto-do-paragrafo:' || encode(sha256(convert_to(coalesce(p.texto, ''), 'UTF8')), 'hex')
                    else c.trecho
                  end) || ','
             || acervo.json_de_texto(c.idioma) || ']',
         ',' order by c.ordem), '')
    || ']', 'UTF8')), 'hex')
  from acervo.citacao c
  left join acervo.fonte_paragrafo p on p.id = c.fonte_paragrafo_id
 where c.afirmacao_id = p_afirmacao
$$;

revoke all on function acervo.hash_citacoes(text) from public;
grant execute on function acervo.hash_citacoes(text) to jnf_app, jnf_assistente, jnf_carga;
