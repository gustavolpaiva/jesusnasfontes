-- 0035 — Acervo: `aprovar_afirmacao` trava Fontes antes de fichas, em ordem de endereço (plano 02-24, quinta passada da revisão cruzada, MÉDIA).
-- Idempotente. Sem segredo. A 0034 já está aplicada e não é editada.
--
-- Achado (deduzido do código, sem reprodução): uma Afirmação com Citação a uma ficha X e a um parágrafo da Fonte Y; uma carga que segura a Fonte Y e
-- depois atualiza a Fonte de X (o gatilho `fonte_atualiza_ficha` atualiza a ficha) e a aprovação, que segurava a ficha X e esperava a Fonte Y: ciclo
-- de espera, e o PostgreSQL aborta uma das duas (40P01). O risco vem da 0028 (a 0034 só mudou a ordem em relação ao hash). Agora a aprovação trava
-- as Fontes de TODOS os alvos (parágrafos e fichas) na ordem do endereço, a da carga, e só depois as fichas, também em ordem. Sem teste de
-- concorrência dedicado ao ciclo (exigiria carga e ficha verificada em duas conexões); os testes de concorrência da aprovação seguem verdes.

create or replace function acervo.aprovar_afirmacao(
  p_sessao uuid, p_afirmacao text, p_texto_hash text, p_grau text, p_citacoes_hash text
) returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_texto_hash text;
  v_citacoes_hash text;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  if p_grau is null or p_grau not in ('consenso', 'posicao-majoritaria', 'disputada') then
    raise exception 'grau fora da lista' using errcode = '22023';
  end if;

  -- Trava a Afirmação ANTES de ler os hashes: uma mudança de texto (a carga) ou de Citação (gatilho) espera esta
  -- transação, e uma em curso faz esta esperar e reler o hash novo.
  select a.texto_hash into v_texto_hash from acervo.afirmacao a where a.id = p_afirmacao for update;
  if v_texto_hash is null or v_texto_hash is distinct from p_texto_hash then
    raise exception 'a Afirmação mudou desde a leitura' using errcode = '40001';
  end if;

  -- Os alvos não mudam de estado sob esta decisão: trava (FOR SHARE) as Fontes de todos os alvos e, só depois, as fichas, SEMPRE na ordem do
  -- endereço da Fonte, a mesma em que a carga as atualiza (`scripts/acervo/carregar.ts` lê os YAMLs em ordem de nome). A Fonte vem antes da
  -- ficha porque é assim que a carga trava (atualizar a Fonte dispara `fonte_atualiza_ficha`, que atualiza a ficha dela): travar a ficha
  -- antes e a Fonte depois fecharia um ciclo com uma carga que segura a Fonte de um parágrafo citado e espera a ficha.
  perform 1
    from acervo.fonte o
   where o.id in (
     select s.fonte_id
       from acervo.citacao c
       join acervo.fonte_paragrafo p on p.id = c.fonte_paragrafo_id
       join acervo.fonte_secao s on s.id = p.secao_id
      where c.afirmacao_id = p_afirmacao
     union
     select i.ficha_id
       from acervo.citacao c join acervo.ficha_item i on i.id = c.ficha_item_id
      where c.afirmacao_id = p_afirmacao)
   order by o.slug
     for share;
  perform 1
    from acervo.ficha fi
   where fi.fonte_id in (
     select i.ficha_id from acervo.citacao c join acervo.ficha_item i on i.id = c.ficha_item_id
      where c.afirmacao_id = p_afirmacao)
   order by fi.fonte_id
     for share;
  v_citacoes_hash := acervo.hash_citacoes(p_afirmacao);
  if v_citacoes_hash is distinct from p_citacoes_hash then
    raise exception 'o conjunto de Citações mudou desde a leitura' using errcode = '40001';
  end if;

  if not exists (select 1 from acervo.citacao c where c.afirmacao_id = p_afirmacao) then
    raise exception 'a Afirmação não tem Citação' using errcode = 'P0002';
  end if;

  if not acervo.citacoes_sustentadas(p_afirmacao) then
    raise exception 'alguma Citação aponta para alvo que não sustenta (ficha não verificada ou Fonte não publicada)'
      using errcode = 'P0003';
  end if;

  -- Os hashes gravados são os lidos do banco com a linha travada, nunca os parâmetros.
  insert into acervo.aprovacao_afirmacao (afirmacao_id, texto_hash, grau, citacoes_hash)
    values (p_afirmacao, v_texto_hash, p_grau, v_citacoes_hash)
    on conflict (afirmacao_id) do update
      set texto_hash = excluded.texto_hash, grau = excluded.grau,
          citacoes_hash = excluded.citacoes_hash, aprovada_em = now();
  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('aprovar-afirmacao', p_afirmacao,
            encode(sha256(convert_to(v_texto_hash || '|' || v_citacoes_hash || '|' || p_grau, 'UTF8')), 'hex'),
            v_admin);
end
$$;

revoke all on function acervo.aprovar_afirmacao(uuid, text, text, text, text) from public;
revoke all on function acervo.aprovar_afirmacao(uuid, text, text, text, text) from jnf_carga, jnf_assistente;
grant execute on function acervo.aprovar_afirmacao(uuid, text, text, text, text) to jnf_app;
