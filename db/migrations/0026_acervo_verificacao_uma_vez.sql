-- 0026 — Acervo: "já conferido / já verificado para este hash?" é decidido DENTRO do banco, sob a mesma trava que grava.
-- Fecha o achado MÉDIA da revisão cruzada do plano 02-18 (0020 já está aplicada e não é editada). Idempotente. Sem segredo.
--
-- O defeito: o painel decidia "já está conferida?" com um SELECT na camada de aplicação e só depois chamava
-- `acervo.conferir_item` / `acervo.verificar_ficha`. Duas abas lendo "ainda não" ao mesmo tempo gravavam as duas: a data
-- da primeira se perdia e o registro de auditoria saía em duplicata. A checagem em TypeScript nunca é atômica.
--
-- A correção: duas funções novas que fazem a checagem e a escrita na MESMA transação, depois de travar a linha com
-- `FOR UPDATE` (a 0020 usa `FOR SHARE` no item, que NÃO serializa duas conferências: as duas travas compartilhadas
-- convivem). A segunda chamada espera a primeira confirmar, relê, vê a evidência do hash e devolve "já estava" sem
-- gravar nada. Resultado: UMA gravação e UMA linha de auditoria por (item, hash) e por (ficha, hash).
--
--   acervo.conferir_item_uma_vez(sessao, item, hash)    -> boolean  true = esta chamada gravou; false = já estava conferido
--   acervo.verificar_ficha_uma_vez(sessao, ficha, hash) -> (gravou boolean, em timestamptz)  `em` = data da verificação vigente
--
-- Os códigos de erro são os da 0020 (42501, 40001, P0001 com `faltam_<n>`, P0002, 0A000). As funções da 0020 ficam
-- como estão (o carregador e os testes de plano 05 as usam, e elas regravam a data de propósito); o painel só usa estas.

-- ───────────────────────── conferir_item_uma_vez ─────────────────────────

create or replace function acervo.conferir_item_uma_vez(p_sessao uuid, p_item text, p_hash text) returns boolean
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_hash text;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  -- FOR UPDATE: serializa duas conferências do mesmo item (e toda mudança do item). Quem chega depois espera o commit
  -- de quem chegou antes e então lê a evidência já gravada.
  select i.conteudo_hash into v_hash from acervo.ficha_item i where i.id = p_item for update;
  if v_hash is null or v_hash is distinct from p_hash then
    raise exception 'o item mudou desde a leitura' using errcode = '40001';
  end if;

  -- Já conferido para ESTE hash (o travado, igual ao que o Admin viu): nada se regrava e nada se audita.
  if exists (select 1 from acervo.conferencia_item c where c.item_id = p_item and c.item_hash = v_hash) then
    return false;
  end if;

  insert into acervo.conferencia_item (item_id, item_hash) values (p_item, v_hash)
    on conflict (item_id) do update set item_hash = excluded.item_hash, conferida_em = now();
  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('conferir-item', p_item, v_hash, v_admin);
  return true;
end
$$;

revoke all on function acervo.conferir_item_uma_vez(uuid, text, text) from public;
revoke all on function acervo.conferir_item_uma_vez(uuid, text, text) from jnf_carga, jnf_assistente;
grant execute on function acervo.conferir_item_uma_vez(uuid, text, text) to jnf_app;

-- ───────────────────────── verificar_ficha_uma_vez ─────────────────────────

create or replace function acervo.verificar_ficha_uma_vez(p_sessao uuid, p_ficha uuid, p_hash text)
returns table (gravou boolean, em timestamptz)
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_hash text;
  v_edicao text;
  v_slug text;
  v_faltam integer;
  v_em timestamptz;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  -- A trava da ficha (FOR UPDATE, como na 0020) serializa duas verificações da mesma ficha e toda mudança de conteúdo.
  select f.conteudo_hash, f.edicao_consultada, o.slug
    into v_hash, v_edicao, v_slug
    from acervo.ficha f
    join acervo.fonte o on o.id = f.fonte_id
   where f.fonte_id = p_ficha
     for update of f;
  if v_hash is null or v_hash is distinct from p_hash then
    raise exception 'a ficha mudou desde a leitura' using errcode = '40001';
  end if;

  -- Já verificada para ESTE hash: devolve a data vigente e não grava nem audita nada.
  select v.verificada_em into v_em
    from acervo.verificacao_ficha v
   where v.ficha_id = p_ficha and v.ficha_hash = v_hash;
  if found then
    return query select false, v_em;
    return;
  end if;

  if v_edicao ilike 'a confirmar%' then
    raise exception 'a edição consultada ainda não foi confirmada' using errcode = 'P0002';
  end if;

  select count(*) into v_faltam
    from acervo.ficha_item i
   where i.ficha_id = p_ficha
     and (i.pagina_inicio is not null or i.pagina_texto is not null)
     and not exists (
       select 1 from acervo.conferencia_item c where c.item_id = i.id and c.item_hash = i.conteudo_hash);
  if v_faltam > 0 then
    raise exception 'faltam % páginas a conferir', v_faltam
      using errcode = 'P0001', constraint = 'faltam_' || v_faltam::text;
  end if;

  insert into acervo.verificacao_ficha (ficha_id, ficha_hash) values (p_ficha, v_hash)
    on conflict (ficha_id) do update set ficha_hash = excluded.ficha_hash, verificada_em = now()
    returning verificada_em into v_em;
  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('verificar-ficha', v_slug, v_hash, v_admin);
  return query select true, v_em;
end
$$;

revoke all on function acervo.verificar_ficha_uma_vez(uuid, uuid, text) from public;
revoke all on function acervo.verificar_ficha_uma_vez(uuid, uuid, text) from jnf_carga, jnf_assistente;
grant execute on function acervo.verificar_ficha_uma_vez(uuid, uuid, text) to jnf_app;
