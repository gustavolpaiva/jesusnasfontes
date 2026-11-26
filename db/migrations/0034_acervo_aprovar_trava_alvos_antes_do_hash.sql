-- 0034 — Acervo: `aprovar_afirmacao` trava os alvos ANTES de ler o hash das Citações (plano 02-24, quarta passada da revisão cruzada, MÉDIA).
-- Idempotente. Sem segredo. A 0028 já está aplicada e não é editada.
--
-- Com o hash lido antes da trava da ficha e da Fonte, uma carga que mudasse o texto de um parágrafo citado (e segurasse a Fonte) fazia a
-- aprovação esperar a trava, depois gravar o hash VELHO e devolver sucesso, com a aprovação já inválida. Agora a função trava os alvos primeiro
-- (FOR SHARE) e só então lê e confere o hash: se a carga mudou o parágrafo, a aprovação espera, relê o hash novo e é recusada com 40001
-- ("o conjunto de Citações mudou desde a leitura"). O corpo é o da 0028; só a ordem dessas duas etapas mudou.

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

  -- Os alvos não mudam de estado sob esta decisão: trava a ficha e a Fonte de cada Citação (FOR SHARE) antes de olhar.
  perform 1
    from acervo.ficha fi
   where fi.fonte_id in (
     select i.ficha_id from acervo.citacao c join acervo.ficha_item i on i.id = c.ficha_item_id
      where c.afirmacao_id = p_afirmacao)
     for share;
  perform 1
    from acervo.fonte o
   where o.id in (
     select s.fonte_id
       from acervo.citacao c
       join acervo.fonte_paragrafo p on p.id = c.fonte_paragrafo_id
       join acervo.fonte_secao s on s.id = p.secao_id
      where c.afirmacao_id = p_afirmacao)
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
