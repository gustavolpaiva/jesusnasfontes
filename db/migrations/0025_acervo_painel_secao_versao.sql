-- 0025 — Acervo: a edição de seção do painel só escreve na seção EXATA que o cliente carregou (terceira revisão cruzada do
-- plano 02-17; 0024 já está aplicada e não é editada). Idempotente. Sem segredo algum neste arquivo.
--
-- O defeito da 0024: um contador por seção, começando em 0, não é identidade. Duas seções com a mesma revisão (A e B, ambas 0)
-- passavam na checagem trocadas, e o pedido de B sobre o endereço de A apagava parágrafos de A. Agora:
--   * `fonte_secao.versao` (uuid) é regerado a CADA escrita da seção (pela seção, pelo resumo ou pela reversão): é único por
--     versão de seção, não repete entre seções nem entre versões da mesma;
--   * `salvar_secao_painel` em modo `editar` recebe o `id` que o servidor deu e o `versao` que o cliente viu; acha a linha POR ID
--     (o endereço vira só exibição: se não bate com o id, 22023), confere que ela é da Fonte pedida (22023) e que a versão é a
--     atual (40001), tudo ANTES de tocar em qualquer parágrafo;
--   * o apagar e o atualizar de parágrafos levam `secao_id = <a linha verificada>` na própria instrução: não há como mirá-los em
--     outra seção.

alter table acervo.fonte_secao add column if not exists versao uuid not null default gen_random_uuid();

create or replace function acervo.salvar_secao_painel(p_sessao uuid, p_slug text, p_secao jsonb) returns text
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  f record;
  v_modo text;
  v_sslug text;
  v_id text;
  v_titulo text;
  v_texto text;
  v_resumo text;
  v_palavras text[];
  v_pars text[];
  v_existentes text[];
  v_prox integer;
  v_ordem integer;
  v_i integer;
  v_n integer;
  v_versao_atual uuid;
  v_fonte_da_secao uuid;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  select id, origem_registro, tipo_texto, idioma into f from acervo.fonte where slug = p_slug for update;
  if not found then
    raise exception 'Fonte inexistente' using errcode = 'P0005';
  end if;
  if f.origem_registro <> 'painel' then
    raise exception 'seção só se cria em Fonte do painel' using errcode = 'P0003';
  end if;

  if p_secao is null or jsonb_typeof(p_secao) <> 'object' then
    raise exception 'seção inválida' using errcode = '22023';
  end if;
  v_modo := p_secao->>'modo';
  if v_modo is null or v_modo not in ('criar', 'editar') then
    raise exception 'modo da seção inválido' using errcode = '22023';
  end if;
  v_sslug := p_secao->>'slug';
  if v_sslug is not null and (v_sslug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_sslug) > 80) then
    raise exception 'slug da seção inválido' using errcode = '22023';
  end if;
  if v_modo = 'editar' then
    -- Editar é escrever na seção EXATA que o cliente carregou: ela é achada pelo id que o servidor deu (nunca pelo endereço
    -- que o cliente manda), tem de ser da Fonte pedida, e o `versao` tem de ser o da versão que o cliente viu.
    v_id := p_secao->>'id';
    if v_id is null or char_length(v_id) > 300 or p_secao->>'versao' is null
       or p_secao->>'versao' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'id e versão da seção são obrigatórios para editar' using errcode = '22023';
    end if;
    -- O endereço, quando vem, é só exibição: se não bate com o id, o pedido é incoerente e é recusado.
    if v_sslug is not null and v_id <> p_slug || '/' || v_sslug then
      raise exception 'o endereço da seção não é o do id' using errcode = '22023';
    end if;
  end if;

  v_titulo := nullif(btrim(p_secao->>'titulo', E' \t\r\n'), '');
  if v_titulo is null or char_length(v_titulo) > 300 then
    raise exception 'título da seção inválido' using errcode = '22023';
  end if;
  v_texto := replace(replace(coalesce(p_secao->>'texto', ''), E'\r\n', E'\n'), E'\r', E'\n');
  if char_length(v_texto) > 80000 then
    raise exception 'texto da seção acima do teto' using errcode = '22023';
  end if;
  v_pars := array(
    select btrim(x.p, E' \t\n') from regexp_split_to_table(v_texto, E'\n[ \t]*\n') with ordinality as x(p, o)
     where btrim(x.p, E' \t\n') <> '' order by x.o);
  if coalesce(cardinality(v_pars), 0) = 0 or cardinality(v_pars) > 5000 then
    raise exception 'a seção precisa de texto (até 5000 parágrafos)' using errcode = '22023';
  end if;
  v_resumo := nullif(btrim(p_secao->>'resumo_pt', E' \t\r\n'), '');
  if v_resumo is not null and char_length(v_resumo) > 2000 then
    raise exception 'resumo grande demais' using errcode = '22023';
  end if;
  v_palavras := array(
    select btrim(x.p, E' \t\r\n') from jsonb_array_elements_text(coalesce(p_secao->'palavras_chave_pt', '[]'::jsonb))
      with ordinality as x(p, o) order by x.o);
  if cardinality(v_palavras) > 30
     or exists (select 1 from unnest(v_palavras) w where w = '' or char_length(w) > 80) then
    raise exception 'palavras-chave inválidas' using errcode = '22023';
  end if;

  if v_modo = 'criar' then
    if v_sslug is null then
      -- O primeiro `secao-<n>` livre: duas seções novas nunca ganham o mesmo endereço.
      v_n := 1;
      while exists (select 1 from acervo.fonte_secao where id = p_slug || '/secao-' || v_n::text) loop
        v_n := v_n + 1;
      end loop;
      v_sslug := 'secao-' || v_n::text;
    end if;
    v_id := p_slug || '/' || v_sslug;
    -- Seção nova nunca substitui uma que já existe.
    if exists (select 1 from acervo.fonte_secao where id = v_id) then
      raise exception 'já existe seção com este endereço' using errcode = '23505', constraint = 'fonte_secao_pkey';
    end if;
    select coalesce(max(s.ordem), 0) + 1 into v_ordem from acervo.fonte_secao s where s.fonte_id = f.id;
    insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt, palavras_chave_pt)
      values (v_id, f.id, v_sslug, v_ordem, v_titulo, v_resumo, v_palavras);
  else
    select s.versao, s.fonte_id into v_versao_atual, v_fonte_da_secao
      from acervo.fonte_secao s where s.id = v_id for update;
    if not found then
      raise exception 'seção inexistente' using errcode = 'P0005';
    end if;
    -- A seção de OUTRA Fonte nunca é escrita por pedido de uma Fonte que não é a dela.
    if v_fonte_da_secao <> f.id then
      raise exception 'a seção não é desta Fonte' using errcode = '22023';
    end if;
    if (p_secao->>'versao')::uuid <> v_versao_atual then
      raise exception 'a seção mudou desde a leitura' using errcode = '40001';
    end if;
    update acervo.fonte_secao
       set titulo = v_titulo, resumo_pt = v_resumo, palavras_chave_pt = v_palavras,
           revisao = revisao + 1, versao = gen_random_uuid()
     where id = v_id;
  end if;

  v_existentes := array(select p.id from acervo.fonte_paragrafo p where p.secao_id = v_id order by p.ordem);
  select coalesce(max(p.ref::integer), 0) into v_prox
    from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id
   where s.fonte_id = f.id and p.ref ~ '^[0-9]{1,9}$';
  for v_i in 1 .. cardinality(v_pars) loop
    if v_i <= coalesce(cardinality(v_existentes), 0) then
      update acervo.fonte_paragrafo set texto = v_pars[v_i], idioma = f.idioma
        where id = v_existentes[v_i] and secao_id = v_id
          and (texto is distinct from v_pars[v_i] or idioma is distinct from f.idioma);
    else
      v_prox := v_prox + 1;
      insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
        values (p_slug || '/' || v_prox::text, v_id, v_i, v_pars[v_i], v_prox::text, f.idioma);
    end if;
  end loop;
  if coalesce(cardinality(v_existentes), 0) > cardinality(v_pars) then
    delete from acervo.fonte_paragrafo
      where secao_id = v_id
        and id = any(v_existentes[cardinality(v_pars) + 1 : cardinality(v_existentes)]);
  end if;

  update acervo.fonte set revisao = revisao + 1 where id = f.id;
  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('salvar-secao', v_id, encode(sha256(convert_to(p_secao::text, 'UTF8')), 'hex'), v_admin);
  return v_id;
end
$$;

revoke all on function acervo.salvar_secao_painel(uuid, text, jsonb) from public;
revoke all on function acervo.salvar_secao_painel(uuid, text, jsonb) from jnf_carga, jnf_assistente;
grant execute on function acervo.salvar_secao_painel(uuid, text, jsonb) to jnf_app;

create or replace function acervo.salvar_resumo_secao(
  p_sessao uuid, p_secao_id text, p_resumo text, p_palavras text[], p_revisao integer default null
) returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_fonte uuid;
  v_tipo text;
  v_atual integer;
  v_resumo text;
  v_palavras text[];
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  select s.fonte_id, f.tipo_texto into v_fonte, v_tipo
    from acervo.fonte_secao s join acervo.fonte f on f.id = s.fonte_id
   where s.id = p_secao_id;
  if not found then
    raise exception 'seção inexistente' using errcode = 'P0005';
  end if;
  if v_tipo = 'ficha' then
    raise exception 'ficha não é editável pelo painel de Fontes' using errcode = 'P0004';
  end if;

  v_resumo := nullif(btrim(p_resumo, E' \t\r\n'), '');
  if v_resumo is not null and char_length(v_resumo) > 2000 then
    raise exception 'resumo grande demais' using errcode = '22023';
  end if;
  v_palavras := array(
    select btrim(x.p, E' \t\r\n') from unnest(coalesce(p_palavras, '{}'::text[])) with ordinality as x(p, o)
     order by x.o);
  if cardinality(v_palavras) > 30
     or exists (select 1 from unnest(v_palavras) w where w = '' or char_length(w) > 80) then
    raise exception 'palavras-chave inválidas' using errcode = '22023';
  end if;

  -- Trava a Fonte antes da seção (a mesma ordem de salvar_secao_painel e da carga) e confere a revisão já travada.
  select revisao into v_atual from acervo.fonte where id = v_fonte for update;
  if p_revisao is not null and p_revisao <> v_atual then
    raise exception 'a Fonte mudou desde a leitura' using errcode = '40001';
  end if;
  update acervo.fonte_secao set resumo_pt = v_resumo, palavras_chave_pt = v_palavras, revisao = revisao + 1,
         versao = gen_random_uuid()
   where id = p_secao_id;
  update acervo.fonte set revisao = revisao + 1 where id = v_fonte;

  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('salvar-resumo', p_secao_id,
            encode(sha256(convert_to(
              jsonb_build_object('resumo', v_resumo, 'palavras', to_jsonb(v_palavras))::text, 'UTF8')), 'hex'),
            v_admin);
end
$$;

revoke all on function acervo.salvar_resumo_secao(uuid, text, text, text[], integer) from public;
revoke all on function acervo.salvar_resumo_secao(uuid, text, text, text[], integer) from jnf_carga, jnf_assistente;
grant execute on function acervo.salvar_resumo_secao(uuid, text, text, text[], integer) to jnf_app;

create or replace function acervo.reverter_fonte(p_sessao uuid, p_slug text, p_campos text[]) returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  f record;
  v_alvo text[];
  c text;
  v_secao text;
  v_campo text;
  s record;
  v_valor jsonb;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  select id, origem_registro, valores_arquivo, valores_recusados, conflito_carga into f
    from acervo.fonte where slug = p_slug for update;
  if not found or f.origem_registro <> 'arquivo' or f.valores_arquivo is null then
    raise exception 'Fonte sem arquivo a que reverter' using errcode = 'P0005';
  end if;

  v_alvo := array(select x from unnest(coalesce(p_campos, f.conflito_carga)) x where x = any(f.conflito_carga));
  if coalesce(cardinality(v_alvo), 0) = 0 then
    raise exception 'nenhum campo em conflito a reverter' using errcode = 'P0005';
  end if;

  foreach c in array v_alvo loop
    if c = 'limites_pt' then
      -- O que o arquivo diz AGORA (o da carga recusada); sem ele, o da última carga aceita.
      v_valor := case when f.valores_recusados ? c then f.valores_recusados->c else f.valores_arquivo->'limites_pt' end;
      update acervo.fonte set limites_pt = case when jsonb_typeof(v_valor) = 'null' then null else v_valor #>> '{}' end
        where id = f.id;
    else
      v_secao := split_part(c, ':', 1);
      v_campo := split_part(c, ':', 2);
      if v_campo not in ('resumo_pt', 'palavras_chave_pt') then
        raise exception 'campo em conflito desconhecido' using errcode = '22023';
      end if;
      select s2.id, s2.valores_arquivo into s
        from acervo.fonte_secao s2 where s2.fonte_id = f.id and s2.slug = v_secao for update;
      if not found or s.valores_arquivo is null then
        raise exception 'seção sem arquivo a que reverter' using errcode = 'P0005';
      end if;
      v_valor := case when f.valores_recusados ? c then f.valores_recusados->c else s.valores_arquivo->v_campo end;
      if v_campo = 'resumo_pt' then
        update acervo.fonte_secao
           set resumo_pt = case when jsonb_typeof(v_valor) = 'null' then null else v_valor #>> '{}' end,
             versao = gen_random_uuid()
         where id = s.id;
      else
        update acervo.fonte_secao
           set palavras_chave_pt = case when jsonb_typeof(v_valor) = 'array'
                 then array(select jsonb_array_elements_text(v_valor)) else '{}'::text[] end,
             versao = gen_random_uuid()
         where id = s.id;
      end if;
    end if;
  end loop;

  update acervo.fonte
     set conflito_carga = array(select x from unnest(conflito_carga) x where x <> all(v_alvo)),
         valores_recusados = (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
                                from jsonb_each(coalesce(valores_recusados, '{}'::jsonb)) as e(k, v)
                               where k <> all(v_alvo)),
         revisao = revisao + 1
   where id = f.id;

  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('reverter-fonte', p_slug,
            encode(sha256(convert_to(to_jsonb(v_alvo)::text, 'UTF8')), 'hex'), v_admin);
end
$$;

revoke all on function acervo.reverter_fonte(uuid, text, text[]) from public;
revoke all on function acervo.reverter_fonte(uuid, text, text[]) from jnf_carga, jnf_assistente;
grant execute on function acervo.reverter_fonte(uuid, text, text[]) to jnf_app;
