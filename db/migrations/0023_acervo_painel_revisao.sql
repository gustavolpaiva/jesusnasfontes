-- 0023 — Acervo: correções da revisão cruzada do plano 02-17 sobre o painel de Fontes (0022 já está aplicada e não é
-- editada). Idempotente: pode ser aplicada de novo. Sem segredo algum neste arquivo.
--
-- 1. Seção nova nunca reaproveita o endereço de uma seção que já existe. `salvar_secao_painel` ganha o `modo` ('criar' ou
--    'editar'): criar com endereço que existe é recusado (23505), criar sem endereço o gera (`secao-<n>`, o primeiro livre),
--    editar o que não existe é P0005. Antes a função era um upsert: um formulário com estado velho sobrescrevia a seção.
-- 2. "Primeiro a gravar vence" não vale mais no painel: a Fonte ganha `revisao`, que SOBE a cada escrita do painel ou da
--    carga que muda a Fonte, e `salvar_fonte` (editar) e `salvar_resumo_secao` recusam (40001) quem escreve sobre uma
--    revisão que já não é a atual. O formulário abre com a revisão que leu e a devolve ao salvar.
-- 3. "Reverter ao arquivo" volta ao que o arquivo diz AGORA: a carga recusada deixa os valores do arquivo em
--    `valores_recusados`, e a reversão os usa (sem eles, cai no valor da última carga aceita).
-- 4. Mudar o idioma de uma Fonte do painel muda o idioma dos parágrafos que ela já tem (mesmo sem mudar o texto), e as
--    colunas geradas da busca (`tsv_en`) acompanham sozinhas.

alter table acervo.fonte add column if not exists revisao integer not null default 0;
-- Valores que o ARQUIVO disse na carga recusada, por campo em conflito (a chave é o nome do campo, como em conflito_carga).
alter table acervo.fonte add column if not exists valores_recusados jsonb null;

-- Fontes do painel que já tinham parágrafo com o idioma antigo (defeito da 0022): alinha ao idioma da Fonte.
update acervo.fonte_paragrafo p
   set idioma = f.idioma
  from acervo.fonte_secao s, acervo.fonte f
 where s.id = p.secao_id and f.id = s.fonte_id and f.origem_registro = 'painel' and p.idioma is distinct from f.idioma;

-- ───────────────────────── salvar_fonte ─────────────────────────

create or replace function acervo.salvar_fonte(p_sessao uuid, p_dados jsonb) returns text
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_modo text;
  v_slug text;
  f record;
  v_nivel text;
  v_tipo text;
  v_tradicao text;
  v_publicada boolean;
  v_revisao integer;
  v_idioma text;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  if p_dados is null or jsonb_typeof(p_dados) <> 'object' then
    raise exception 'dados da Fonte inválidos' using errcode = '22023';
  end if;
  v_modo := p_dados->>'modo';
  v_slug := p_dados->>'slug';
  if v_modo is null or v_modo not in ('criar', 'editar') or v_slug is null
     or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) > 120 then
    raise exception 'modo ou slug inválido' using errcode = '22023';
  end if;

  select id, origem_registro, tipo_texto, revisao into f from acervo.fonte where slug = v_slug for update;
  if v_modo = 'criar' and found then
    raise exception 'já existe Fonte com este slug' using errcode = '23505', constraint = 'fonte_slug_unico';
  end if;
  if v_modo = 'editar' and not found then
    raise exception 'Fonte inexistente' using errcode = 'P0005';
  end if;

  if v_modo = 'editar' then
    -- A revisão que o formulário leu: se a Fonte mudou desde então (outra pessoa, outra aba, uma carga), recusa.
    if p_dados->>'revisao' is null or p_dados->>'revisao' !~ '^[0-9]{1,9}$' then
      raise exception 'revisão da Fonte ausente' using errcode = '22023';
    end if;
    v_revisao := (p_dados->>'revisao')::integer;
    if v_revisao <> f.revisao then
      raise exception 'a Fonte mudou desde a leitura' using errcode = '40001';
    end if;
  end if;

  if v_modo = 'editar' and f.origem_registro = 'arquivo' then
    if f.tipo_texto = 'ficha' then
      raise exception 'ficha não é editável pelo painel de Fontes' using errcode = 'P0004';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_dados) k
       where k not in ('modo', 'slug', 'revisao', 'limites_pt', 'publicada')
    ) then
      raise exception 'campo do arquivo não é editável pelo painel' using errcode = 'P0003';
    end if;
    update acervo.fonte set
        limites_pt = case when p_dados ? 'limites_pt'
                          then nullif(btrim(p_dados->>'limites_pt', E' \t\r\n'), '') else limites_pt end,
        publicada = case when p_dados ? 'publicada'
                         then coalesce((p_dados->>'publicada')::boolean, false) else publicada end,
        revisao = revisao + 1
      where id = f.id;
  else
    v_nivel := p_dados->>'nivel';
    v_tipo := p_dados->>'tipo_texto';
    if v_nivel is null or v_tipo is null or nullif(btrim(p_dados->>'titulo', E' \t\r\n'), '') is null then
      raise exception 'título, Nível e tipo são obrigatórios' using errcode = '22023';
    end if;
    v_tradicao := nullif(btrim(p_dados->>'tradicao', E' \t\r\n'), '');
    if v_nivel = 'confessional' and v_tradicao is null then
      raise exception 'leitura confessional exige a tradição' using errcode = 'P0006';
    end if;
    if v_nivel <> 'confessional' then
      v_tradicao := null;
    end if;
    v_idioma := coalesce(p_dados->>'idioma', 'pt');
    v_publicada := case when v_tipo = 'ficha' then false
                        else coalesce((p_dados->>'publicada')::boolean, false) end;

    if v_modo = 'criar' then
      insert into acervo.fonte (
        slug, titulo, autor, epoca, nivel, tradicao, tipo_texto, idioma, obra_protegida, origem_nome, origem_url,
        licenca, licenca_url, tradutor, traducao_ano, edicao, traduzida_por_nos, limites_pt, publicada,
        origem_registro)
      values (
        v_slug,
        btrim(p_dados->>'titulo', E' \t\r\n'),
        nullif(btrim(p_dados->>'autor', E' \t\r\n'), ''),
        nullif(btrim(p_dados->>'epoca', E' \t\r\n'), ''),
        v_nivel, v_tradicao, v_tipo,
        v_idioma,
        coalesce((p_dados->>'obra_protegida')::boolean, false),
        nullif(btrim(p_dados->>'origem_nome', E' \t\r\n'), ''),
        nullif(btrim(p_dados->>'origem_url', E' \t\r\n'), ''),
        nullif(btrim(p_dados->>'licenca', E' \t\r\n'), ''),
        nullif(btrim(p_dados->>'licenca_url', E' \t\r\n'), ''),
        nullif(btrim(p_dados->>'tradutor', E' \t\r\n'), ''),
        (nullif(btrim(p_dados->>'traducao_ano', E' \t\r\n'), ''))::smallint,
        nullif(btrim(p_dados->>'edicao', E' \t\r\n'), ''),
        coalesce((p_dados->>'traduzida_por_nos')::boolean, false),
        nullif(btrim(p_dados->>'limites_pt', E' \t\r\n'), ''),
        v_publicada,
        'painel');
    else
      update acervo.fonte set
          titulo = btrim(p_dados->>'titulo', E' \t\r\n'),
          autor = nullif(btrim(p_dados->>'autor', E' \t\r\n'), ''),
          epoca = nullif(btrim(p_dados->>'epoca', E' \t\r\n'), ''),
          nivel = v_nivel,
          tradicao = v_tradicao,
          tipo_texto = v_tipo,
          idioma = v_idioma,
          obra_protegida = coalesce((p_dados->>'obra_protegida')::boolean, false),
          origem_nome = nullif(btrim(p_dados->>'origem_nome', E' \t\r\n'), ''),
          origem_url = nullif(btrim(p_dados->>'origem_url', E' \t\r\n'), ''),
          licenca = nullif(btrim(p_dados->>'licenca', E' \t\r\n'), ''),
          licenca_url = nullif(btrim(p_dados->>'licenca_url', E' \t\r\n'), ''),
          tradutor = nullif(btrim(p_dados->>'tradutor', E' \t\r\n'), ''),
          traducao_ano = (nullif(btrim(p_dados->>'traducao_ano', E' \t\r\n'), ''))::smallint,
          edicao = nullif(btrim(p_dados->>'edicao', E' \t\r\n'), ''),
          traduzida_por_nos = coalesce((p_dados->>'traduzida_por_nos')::boolean, false),
          limites_pt = nullif(btrim(p_dados->>'limites_pt', E' \t\r\n'), ''),
          publicada = v_publicada,
          revisao = revisao + 1
        where id = f.id;
      -- O idioma da Fonte é o dos parágrafos dela: mudou o idioma, mudam os parágrafos que já existem (mesmo sem mudar o
      -- texto). As colunas geradas da busca seguem sozinhas.
      update acervo.fonte_paragrafo p set idioma = v_idioma
        from acervo.fonte_secao s
       where s.id = p.secao_id and s.fonte_id = f.id and p.idioma is distinct from v_idioma;
    end if;
  end if;

  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('salvar-fonte', v_slug, encode(sha256(convert_to(p_dados::text, 'UTF8')), 'hex'), v_admin);
  return v_slug;
end
$$;

revoke all on function acervo.salvar_fonte(uuid, jsonb) from public;
revoke all on function acervo.salvar_fonte(uuid, jsonb) from jnf_carga, jnf_assistente;
grant execute on function acervo.salvar_fonte(uuid, jsonb) to jnf_app;

-- ───────────────────────── salvar_secao_painel ─────────────────────────

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
  if v_modo = 'editar' and v_sslug is null then
    raise exception 'editar a seção exige o endereço dela' using errcode = '22023';
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
    v_id := p_slug || '/' || v_sslug;
    perform 1 from acervo.fonte_secao where id = v_id and fonte_id = f.id for update;
    if not found then
      raise exception 'seção inexistente' using errcode = 'P0005';
    end if;
    update acervo.fonte_secao set titulo = v_titulo, resumo_pt = v_resumo, palavras_chave_pt = v_palavras
      where id = v_id;
  end if;

  v_existentes := array(select p.id from acervo.fonte_paragrafo p where p.secao_id = v_id order by p.ordem);
  select coalesce(max(p.ref::integer), 0) into v_prox
    from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id
   where s.fonte_id = f.id and p.ref ~ '^[0-9]{1,9}$';
  for v_i in 1 .. cardinality(v_pars) loop
    if v_i <= coalesce(cardinality(v_existentes), 0) then
      update acervo.fonte_paragrafo set texto = v_pars[v_i], idioma = f.idioma
        where id = v_existentes[v_i] and (texto is distinct from v_pars[v_i] or idioma is distinct from f.idioma);
    else
      v_prox := v_prox + 1;
      insert into acervo.fonte_paragrafo (id, secao_id, ordem, texto, ref, idioma)
        values (p_slug || '/' || v_prox::text, v_id, v_i, v_pars[v_i], v_prox::text, f.idioma);
    end if;
  end loop;
  if coalesce(cardinality(v_existentes), 0) > cardinality(v_pars) then
    delete from acervo.fonte_paragrafo
      where id = any(v_existentes[cardinality(v_pars) + 1 : cardinality(v_existentes)]);
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

-- ───────────────────────── salvar_resumo_secao ─────────────────────────

-- Ganha `p_revisao` (opcional só para quem não tem formulário: o painel sempre o envia). A assinatura de quatro
-- argumentos sai: duas funções de mesmo nome e argumentos com valor padrão seriam ambíguas.
drop function if exists acervo.salvar_resumo_secao(uuid, text, text, text[]);

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
  update acervo.fonte_secao set resumo_pt = v_resumo, palavras_chave_pt = v_palavras where id = p_secao_id;
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

-- ───────────────────────── reverter_fonte ─────────────────────────

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
           set resumo_pt = case when jsonb_typeof(v_valor) = 'null' then null else v_valor #>> '{}' end
         where id = s.id;
      else
        update acervo.fonte_secao
           set palavras_chave_pt = case when jsonb_typeof(v_valor) = 'array'
                 then array(select jsonb_array_elements_text(v_valor)) else '{}'::text[] end
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
