-- 0036 — Acervo: o hash das Citações distingue "trecho" de "texto do parágrafo" sem ambiguidade (plano 02-24, sexta passada da revisão cruzada, ALTA
-- deduzida). Idempotente. Sem segredo. A 0033 já está aplicada e não é editada.
--
-- Na 0033 a Citação de parágrafo SEM trecho entrava no hash como o texto 'texto-do-paragrafo:<sha256 do parágrafo>', no mesmo campo do trecho. Uma carga
-- que trocasse o parágrafo E gravasse como trecho esse mesmo texto (que então também estaria dentro do parágrafo novo, passando a conferência de
-- presença) reproduziria o hash e manteria a aprovação para conteúdo diferente. O campo agora é um par: ["paragrafo", sha256] quando não há trecho
-- e ["trecho", texto] quando há; um trecho nunca pode se passar pelo hash do parágrafo. Nenhuma Afirmação está aprovada em nenhum banco até esta
-- data, então nenhuma aprovação é invalidada por mudar o formato.

create or replace function acervo.hash_citacoes(p_afirmacao text) returns text
language sql stable security definer
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to(
    '["jnf-citacoes-v2",'
    || coalesce(string_agg(
         '[' || c.ordem::text || ','
             || acervo.json_de_texto(
                  case
                    when c.fonte_paragrafo_id is not null then 'p:' || c.fonte_paragrafo_id
                    when c.ficha_item_id is not null then 'i:' || c.ficha_item_id
                    else 'v:' || c.versiculo_inicio::text || '-' || c.versiculo_fim::text
                  end) || ','
             || case
                  when c.fonte_paragrafo_id is not null and c.trecho is null
                    then '["paragrafo",' || acervo.json_de_texto(encode(sha256(convert_to(coalesce(p.texto, ''), 'UTF8')), 'hex')) || ']'
                  else '["trecho",' || acervo.json_de_texto(c.trecho) || ']'
                end || ','
             || acervo.json_de_texto(c.idioma) || ']',
         ',' order by c.ordem), '')
    || ']', 'UTF8')), 'hex')
  from acervo.citacao c
  left join acervo.fonte_paragrafo p on p.id = c.fonte_paragrafo_id
 where c.afirmacao_id = p_afirmacao
$$;

revoke all on function acervo.hash_citacoes(text) from public;
grant execute on function acervo.hash_citacoes(text) to jnf_app, jnf_assistente, jnf_carga;
