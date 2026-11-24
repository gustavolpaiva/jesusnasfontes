-- 0022 — Acervo: o painel de Fontes do Admin (ACER-08, ACER-09, D-03). Idempotente: pode ser aplicada de novo. Sem
-- segredo algum neste arquivo.
--
-- Duas portas gravam uma Fonte: o arquivo versionado (a carga, `jnf_carga`) e o painel (estas funções). Este arquivo dá
-- ao painel as únicas portas de escrita, e dá à carga o que ela precisa para NÃO sobrescrever em silêncio o que o painel
-- editou:
--
--   acervo.salvar_fonte(sessao, dados)             cria ou edita uma Fonte
--   acervo.salvar_secao_painel(sessao, slug, secao) cria ou edita uma seção (e os parágrafos) de Fonte do painel
--   acervo.salvar_resumo_secao(sessao, secao, ...)  resumo e palavras-chave de uma seção (qualquer origem)
--   acervo.reverter_fonte(sessao, slug, campos)     devolve ao arquivo os campos que a carga recusou
--
-- Todas são `security definer` de jnf_migra, reexigem a sessão de um Admin com segundo fator (`acervo.exigir_admin_mfa`,
-- 42501 se não houver) e só `jnf_app` as executa. Nenhuma confia em identidade ou em hash enviados pelo chamador: o Admin
-- sai da sessão, e o hash do registro interno é calculado aqui, sobre o que foi gravado. As restrições de linha e os
-- gatilhos de ACER-09 (0016 a 0019) continuam sendo quem recusa: a função NÃO repete essa regra, só a deixa disparar.
--
-- Códigos de erro (o painel os distingue sem ler texto do banco):
--   42501  sessão sem segundo fator
--   23514  ACER-09: obra protegida com texto integral (restrição `fonte_obra_protegida_sem_texto_integral`), texto
--          integral sem licença ou origem https (`fonte_texto_integral_exige_licenca_e_origem`) ou gatilho de texto
--   23505  já existe Fonte com este slug (restrição `fonte_slug_unico`)
--   P0003  Fonte do arquivo: este campo não é editável pelo painel (ou seção só se cria em Fonte do painel)
--   P0004  Fonte de ficha: o painel de Fontes não a edita (a ficha se verifica pela fila de fichas)
--   P0005  a Fonte, a seção ou o conflito pedido não existe
--   P0006  leitura confessional exige a tradição
--   22023  parâmetro inválido (vazio, grande demais, fora do formato)
--   0A000  transação fora de READ COMMITTED (ver 0019: a checagem de outras linhas depende disso)
--
-- Concorrência com a carga: cada função TRAVA a linha da Fonte (`for update`) antes de ler ou escrever, e a carga faz o
-- mesmo ao ler a Fonte. Uma edição do painel em curso faz a carga esperar e, ao acordar, enxergar a edição (e recusar a
-- Fonte); a carga em curso faz o painel esperar e gravar por cima do que a carga leu. Em nenhum caso a carga escreve
-- sobre uma edição que ela não viu.

-- ───────────────────────── colunas da Fonte e da seção ─────────────────────────

-- Hash dos campos do arquivo na ÚLTIMA carga, e esses valores (para a carga saber o que mudou e para "Reverter ao
-- arquivo"). Nulos em Fonte carregada antes desta migração: a carga seguinte os preenche sem acusar conflito.
alter table acervo.fonte add column if not exists hash_ultima_carga text null;
alter table acervo.fonte add column if not exists valores_arquivo jsonb null;
-- Campos da última carga recusada por edição no painel (vazio = sem conflito). `limites_pt`, ou `<seção>:resumo_pt` e
-- `<seção>:palavras_chave_pt`.
alter table acervo.fonte add column if not exists conflito_carga text[] not null default '{}';
-- O que o ARQUIVO dizia de "publicada" na última carga: a mescla de três vias (arquivo, última carga, painel).
alter table acervo.fonte add column if not exists publicada_arquivo boolean null;
-- Tradição de uma leitura confessional (só Fonte do painel; a do arquivo não a declara).
alter table acervo.fonte add column if not exists tradicao text null;

alter table acervo.fonte drop constraint if exists fonte_tradicao_formato;
alter table acervo.fonte add constraint fonte_tradicao_formato
  check (tradicao is null or (length(btrim(tradicao)) > 0 and char_length(tradicao) <= 120));

alter table acervo.fonte_secao add column if not exists hash_ultima_carga text null;
alter table acervo.fonte_secao add column if not exists valores_arquivo jsonb null;

-- ───────────────────────── registro interno: as ações do painel ─────────────────────────

-- O registro nasceu para as duas portas de evidência (0017); o painel acrescenta as dele. `hash` é sempre o sha256 do
-- que a função gravou, calculado no banco.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'admin.registro_verificacao'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%acao%'
  loop
    execute format('alter table admin.registro_verificacao drop constraint %I', c.conname);
  end loop;
end
$$;

alter table admin.registro_verificacao add constraint registro_verificacao_acao_valida
  check (acao in (
    'conferir-item', 'verificar-ficha', 'salvar-fonte', 'salvar-secao', 'salvar-resumo', 'reverter-fonte'));

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

  -- A linha da Fonte fica travada até o fim desta transação (a carga espera por ela).
  select id, origem_registro, tipo_texto into f from acervo.fonte where slug = v_slug for update;
  if v_modo = 'criar' and found then
    raise exception 'já existe Fonte com este slug' using errcode = '23505', constraint = 'fonte_slug_unico';
  end if;
  if v_modo = 'editar' and not found then
    raise exception 'Fonte inexistente' using errcode = 'P0005';
  end if;

  if v_modo = 'editar' and f.origem_registro = 'arquivo' then
    -- A Fonte do arquivo é do arquivo: o painel só mexe nos limites e na publicação.
    if f.tipo_texto = 'ficha' then
      raise exception 'ficha não é editável pelo painel de Fontes' using errcode = 'P0004';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_dados) k where k not in ('modo', 'slug', 'limites_pt', 'publicada')
    ) then
      raise exception 'campo do arquivo não é editável pelo painel' using errcode = 'P0003';
    end if;
    update acervo.fonte set
        limites_pt = case when p_dados ? 'limites_pt'
                          then nullif(btrim(p_dados->>'limites_pt', E' \t\r\n'), '') else limites_pt end,
        publicada = case when p_dados ? 'publicada'
                         then coalesce((p_dados->>'publicada')::boolean, false) else publicada end
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
    -- Ficha não é "publicada": a visibilidade dela é a verificação (0017).
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
        coalesce(p_dados->>'idioma', 'pt'),
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
          idioma = coalesce(p_dados->>'idioma', 'pt'),
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
          publicada = v_publicada
        where id = f.id;
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

-- Seção e parágrafos de uma Fonte DO PAINEL. O texto vem em um bloco: os parágrafos são separados por linha em branco e
-- viram `<slug da Fonte>/<n>` (n corre pela Fonte inteira). Reeditar a seção reaproveita os ids pela posição, para que
-- uma Citação não perca o parágrafo ao se corrigir uma vírgula; o que sobra do fim é apagado (e, se tem Citação, a
-- chave estrangeira recusa).
create or replace function acervo.salvar_secao_painel(p_sessao uuid, p_slug text, p_secao jsonb) returns text
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  f record;
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
  v_sslug := p_secao->>'slug';
  if v_sslug is null or v_sslug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_sslug) > 80 then
    raise exception 'slug da seção inválido' using errcode = '22023';
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

  v_id := p_slug || '/' || v_sslug;
  perform 1 from acervo.fonte_secao where id = v_id and fonte_id = f.id for update;
  if found then
    update acervo.fonte_secao set titulo = v_titulo, resumo_pt = v_resumo, palavras_chave_pt = v_palavras
      where id = v_id;
  else
    if exists (select 1 from acervo.fonte_secao where id = v_id) then
      raise exception 'seção de outra Fonte' using errcode = 'P0003';
    end if;
    select coalesce(max(s.ordem), 0) + 1 into v_ordem from acervo.fonte_secao s where s.fonte_id = f.id;
    insert into acervo.fonte_secao (id, fonte_id, slug, ordem, titulo, resumo_pt, palavras_chave_pt)
      values (v_id, f.id, v_sslug, v_ordem, v_titulo, v_resumo, v_palavras);
  end if;

  v_existentes := array(select p.id from acervo.fonte_paragrafo p where p.secao_id = v_id order by p.ordem);
  select coalesce(max(p.ref::integer), 0) into v_prox
    from acervo.fonte_paragrafo p join acervo.fonte_secao s on s.id = p.secao_id
   where s.fonte_id = f.id and p.ref ~ '^[0-9]{1,9}$';
  for v_i in 1 .. cardinality(v_pars) loop
    if v_i <= coalesce(cardinality(v_existentes), 0) then
      update acervo.fonte_paragrafo set texto = v_pars[v_i]
        where id = v_existentes[v_i] and texto is distinct from v_pars[v_i];
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

  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('salvar-secao', v_id, encode(sha256(convert_to(p_secao::text, 'UTF8')), 'hex'), v_admin);
  return v_id;
end
$$;

revoke all on function acervo.salvar_secao_painel(uuid, text, jsonb) from public;
revoke all on function acervo.salvar_secao_painel(uuid, text, jsonb) from jnf_carga, jnf_assistente;
grant execute on function acervo.salvar_secao_painel(uuid, text, jsonb) to jnf_app;

-- ───────────────────────── salvar_resumo_secao ─────────────────────────

-- Resumo e palavras-chave em português (D-18): o único campo de uma seção do ARQUIVO que o painel edita. Serve a Fonte
-- de qualquer origem; a carga o trata como campo editado no painel (conflito) se o arquivo discordar depois.
create or replace function acervo.salvar_resumo_secao(
  p_sessao uuid, p_secao_id text, p_resumo text, p_palavras text[]
) returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_fonte uuid;
  v_tipo text;
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

  -- Trava a Fonte antes da seção (a mesma ordem de salvar_secao_painel e da carga).
  perform 1 from acervo.fonte where id = v_fonte for update;
  update acervo.fonte_secao set resumo_pt = v_resumo, palavras_chave_pt = v_palavras where id = p_secao_id;

  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('salvar-resumo', p_secao_id,
            encode(sha256(convert_to(
              jsonb_build_object('resumo', v_resumo, 'palavras', to_jsonb(v_palavras))::text, 'UTF8')), 'hex'),
            v_admin);
end
$$;

revoke all on function acervo.salvar_resumo_secao(uuid, text, text, text[]) from public;
revoke all on function acervo.salvar_resumo_secao(uuid, text, text, text[]) from jnf_carga, jnf_assistente;
grant execute on function acervo.salvar_resumo_secao(uuid, text, text, text[]) to jnf_app;

-- ───────────────────────── reverter_fonte ─────────────────────────

-- Devolve ao valor da última carga os campos pedidos (ou todos os do conflito) e os tira de `conflito_carga`. A mudança é
-- imediata: esperar a próxima carga faria a mensagem do painel ("os campos voltam ao que está no arquivo") mentir.
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
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  select id, origem_registro, valores_arquivo, conflito_carga into f
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
      update acervo.fonte set limites_pt = f.valores_arquivo->>'limites_pt' where id = f.id;
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
      if v_campo = 'resumo_pt' then
        update acervo.fonte_secao set resumo_pt = s.valores_arquivo->>'resumo_pt' where id = s.id;
      else
        update acervo.fonte_secao
           set palavras_chave_pt = array(select jsonb_array_elements_text(s.valores_arquivo->'palavras_chave_pt'))
         where id = s.id;
      end if;
    end if;
  end loop;

  update acervo.fonte
     set conflito_carga = array(select x from unnest(conflito_carga) x where x <> all(v_alvo))
   where id = f.id;

  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('reverter-fonte', p_slug,
            encode(sha256(convert_to(to_jsonb(v_alvo)::text, 'UTF8')), 'hex'), v_admin);
end
$$;

revoke all on function acervo.reverter_fonte(uuid, text, text[]) from public;
revoke all on function acervo.reverter_fonte(uuid, text, text[]) from jnf_carga, jnf_assistente;
grant execute on function acervo.reverter_fonte(uuid, text, text[]) to jnf_app;
