-- 0018 — Acervo: integridade da ficha verificada e do texto integral de obra protegida. Fecha dois achados ALTA da
-- revisão cruzada do plano 02-02 (0017 já está aplicada e não é editada). Idempotente: pode ser aplicada de novo.
-- Sem segredo algum neste arquivo.
--
-- 1. O hash do conteúdo da ficha passa a ser CALCULADO NO BANCO. Antes (0017), quem escrevia a ficha enviava
--    `conteudo_hash`, e a verificação valia enquanto `ficha_hash` fosse igual a ele: a carga podia trocar `tese_pt`
--    (ou um item) e a ficha continuava "verificada" com o texto adulterado. Agora gatilhos recalculam o hash a cada
--    mudança de ficha, de item ou de campo da Fonte que o hash cobre, para TODOS os papéis (inclusive o dono do
--    esquema), e ignoram o valor enviado. A verificação (`verificacao_ficha.ficha_hash`) é evidência de um hash que
--    ninguém escolhe; mudou o conteúdo, mudou o hash, e a ficha volta a ser rascunho.
--    O formato é o MESMO de `src/modules/acervo/hash-ficha.ts` (sha256 de um JSON canônico, igual ao de
--    `JSON.stringify`, byte a byte); um teste de integração compara os dois com texto de borda.
--
-- 2. ACER-09 por chave estrangeira móvel: mover uma seção que já tem parágrafo para uma Fonte protegida ou de ficha
--    passava pelos gatilhos de 0017 (eles olhavam o parágrafo e a marca da Fonte, nunca a troca de Fonte da seção).
--    E a decisão dos gatilhos não era segura contra duas transações concorrentes (cada uma não via a outra ainda sem
--    commit): agora o gatilho do parágrafo trava a seção e a Fonte (FOR SHARE) e a mudança concorrente espera.
--
-- Limite honesto (igual ao de 0017): quem controla o papel `jnf_migra` pode desligar gatilho. Isto fecha o código de
-- carga, o agente e o aplicativo.

-- ───────────────────────── 1. hash da ficha no banco ─────────────────────────

-- Texto como `JSON.stringify` o escreve: aspas, barra invertida, \b \f \n \r \t e \u00XX para o resto do controle;
-- o que não é controle (acento, emoji, `/`, DEL, U+2028) sai literal, nos dois lados. Nulo vira `null`.
create or replace function acervo.json_de_texto(t text) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$ select coalesce(to_json(t)::text, 'null') $$;

revoke all on function acervo.json_de_texto(text) from public;

-- O hash de um item: o mesmo dos campos que `hashDoItem` serializa. A página é `n:<início>-<fim>` quando é número
-- e `t:<texto>` quando não é (a restrição `ficha_item_pagina_exclusiva`, abaixo, garante que só um dos dois existe).
create or replace function acervo.hash_do_item(
  p_tipo text, p_texto_pt text, p_pagina_inicio integer, p_pagina_fim integer, p_pagina_texto text,
  p_trecho_original text, p_idioma_trecho text
) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select encode(sha256(convert_to(
    '["jnf-ficha-item-v1",'
    || acervo.json_de_texto(p_tipo) || ','
    || acervo.json_de_texto(p_texto_pt) || ','
    || acervo.json_de_texto(
         case when p_pagina_inicio is not null
              then 'n:' || p_pagina_inicio::text || '-' || p_pagina_fim::text
              else 't:' || p_pagina_texto end) || ','
    || acervo.json_de_texto(p_trecho_original) || ','
    || acervo.json_de_texto(p_idioma_trecho) || ']',
    'UTF8')), 'hex')
$$;

revoke all on function acervo.hash_do_item(text, text, integer, integer, text, text, text) from public;

-- O hash da ficha: os campos dela, os da Fonte que a descrevem (slug, título, autor, limites) e os itens, argumentos
-- antes de trechos e cada tipo pela ordem. Lê as tabelas sem depender da política de linha de quem escreve.
create or replace function acervo.hash_da_ficha(
  p_fonte_id uuid, p_ano smallint, p_editora text, p_edicao_consultada text, p_tese_pt text, p_idioma_trechos text
) returns text
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  f record;
  itens text;
begin
  select slug, titulo, autor, limites_pt into f from acervo.fonte where id = p_fonte_id;
  if not found then
    raise exception 'ficha sem Fonte' using errcode = '23503';
  end if;
  select coalesce(string_agg(
           '[' || acervo.json_de_texto(i.id) || ','
               || acervo.json_de_texto(acervo.hash_do_item(
                    i.tipo, i.texto_pt, i.pagina_inicio, i.pagina_fim, i.pagina_texto,
                    i.trecho_original, i.idioma_trecho)) || ']',
           ',' order by i.tipo, i.ordem), '')
    into itens
    from acervo.ficha_item i
   where i.ficha_id = p_fonte_id;
  return encode(sha256(convert_to(
    '["jnf-ficha-v1",'
    || acervo.json_de_texto(f.slug) || ','
    || acervo.json_de_texto(f.titulo) || ','
    || acervo.json_de_texto(f.autor) || ','
    || coalesce(p_ano::text, 'null') || ','
    || acervo.json_de_texto(p_editora) || ','
    || acervo.json_de_texto(p_edicao_consultada) || ','
    || acervo.json_de_texto(p_tese_pt) || ','
    || acervo.json_de_texto(f.limites_pt) || ','
    || acervo.json_de_texto(p_idioma_trechos) || ','
    || '[' || itens || ']]',
    'UTF8')), 'hex');
end
$$;

revoke all on function acervo.hash_da_ficha(uuid, smallint, text, text, text, text) from public;

-- A ficha grava SEMPRE o hash que o banco calculou, nunca o que veio na linha. Hash novo = `atualizado_em` novo.
create or replace function acervo.ficha_calcula_hash() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  new.conteudo_hash := acervo.hash_da_ficha(
    new.fonte_id, new.ano, new.editora, new.edicao_consultada, new.tese_pt, new.idioma_trechos);
  if tg_op = 'UPDATE' and new.conteudo_hash is distinct from old.conteudo_hash then
    new.atualizado_em := now();
  end if;
  return new;
end
$$;

revoke all on function acervo.ficha_calcula_hash() from public;

drop trigger if exists ficha_hash_no_banco on acervo.ficha;
create trigger ficha_hash_no_banco
  before insert or update on acervo.ficha
  for each row execute function acervo.ficha_calcula_hash();

-- O item idem: o hash dele é o que o banco calcula.
create or replace function acervo.ficha_item_calcula_hash() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  new.conteudo_hash := acervo.hash_do_item(
    new.tipo, new.texto_pt, new.pagina_inicio, new.pagina_fim, new.pagina_texto,
    new.trecho_original, new.idioma_trecho);
  return new;
end
$$;

revoke all on function acervo.ficha_item_calcula_hash() from public;

drop trigger if exists ficha_item_hash_no_banco on acervo.ficha_item;
create trigger ficha_item_hash_no_banco
  before insert or update on acervo.ficha_item
  for each row execute function acervo.ficha_item_calcula_hash();

-- Mudou um item (entrou, saiu, mudou, trocou de ficha): a ficha dele (e a de origem, se trocou) recalcula o hash. Um
-- `update` sem mudar valor dispara o gatilho de hash da ficha, que é quem decide se mudou. `security definer`:
-- o papel de carga não tem (nem precisa ter) escrita fora do que o gatilho faz.
create or replace function acervo.ficha_item_atualiza_ficha() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update acervo.ficha set atualizado_em = atualizado_em where fonte_id = old.ficha_id;
  end if;
  if tg_op = 'INSERT' or (tg_op = 'UPDATE' and new.ficha_id is distinct from old.ficha_id) then
    update acervo.ficha set atualizado_em = atualizado_em where fonte_id = new.ficha_id;
  end if;
  return null;
end
$$;

revoke all on function acervo.ficha_item_atualiza_ficha() from public;

drop trigger if exists ficha_item_recalcula_ficha on acervo.ficha_item;
create trigger ficha_item_recalcula_ficha
  after insert or update or delete on acervo.ficha_item
  for each row execute function acervo.ficha_item_atualiza_ficha();

-- Campo da Fonte que o hash da ficha cobre mudou: a ficha dela recalcula.
create or replace function acervo.fonte_atualiza_ficha() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  update acervo.ficha set atualizado_em = atualizado_em where fonte_id = new.id;
  return null;
end
$$;

revoke all on function acervo.fonte_atualiza_ficha() from public;

drop trigger if exists fonte_recalcula_ficha on acervo.fonte;
create trigger fonte_recalcula_ficha
  after update of slug, titulo, autor, limites_pt on acervo.fonte
  for each row execute function acervo.fonte_atualiza_ficha();

-- O id do item é `<slug>/<tipo>-<ordem>` e entra no hash; o tipo e a ordem das colunas têm de ser os do id, senão
-- uma coluna mudaria sem o hash saber. E a página é numérica OU em texto, nunca as duas: o texto não entraria no
-- hash quando há número.
alter table acervo.ficha_item drop constraint if exists ficha_item_id_coerente;
alter table acervo.ficha_item add constraint ficha_item_id_coerente
  check (id like '%/' || tipo || '-' || ordem::text);

alter table acervo.ficha_item drop constraint if exists ficha_item_pagina_exclusiva;
alter table acervo.ficha_item add constraint ficha_item_pagina_exclusiva
  check ((pagina_inicio is null) <> (pagina_texto is null));

-- Recalcula o que já existe (os hashes de antes da 0018 passam a ser os do banco; são os mesmos se o conteúdo é o
-- mesmo, e uma verificação só vale enquanto bater).
update acervo.ficha_item set id = id;
update acervo.ficha set atualizado_em = atualizado_em;

-- ───────────────────────── 2. ACER-09: chaves móveis e corrida ─────────────────────────

-- O parágrafo só entra (ou muda de seção) sob Fonte de texto integral não protegida. A seção e a Fonte são TRAVADAS
-- para leitura compartilhada antes da checagem: uma mudança concorrente (virar protegida, mover a seção) espera o
-- commit deste parágrafo e, ao acordar, vê o parágrafo e é recusada; uma já em curso faz este esperar e reler. Duas
-- statements, de propósito: a leitura da Fonte só começa depois que a trava da seção foi obtida.
create or replace function acervo.recusar_texto_integral_protegido() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  bloqueada boolean;
begin
  perform 1 from acervo.fonte_secao s where s.id = new.secao_id for share;
  select (f.obra_protegida or f.tipo_texto <> 'integral')
    into bloqueada
    from acervo.fonte f
    join acervo.fonte_secao s on s.fonte_id = f.id
   where s.id = new.secao_id
     for share of f;
  if bloqueada then
    raise exception 'texto integral recusado: obra protegida ou ficha' using errcode = '23514';
  end if;
  return new;
end
$$;

revoke all on function acervo.recusar_texto_integral_protegido() from public;

-- A seção com parágrafo não troca de Fonte para uma protegida ou de ficha. A Fonte de destino é travada
-- (FOR SHARE): quem a esteja marcando como protegida ao mesmo tempo espera este commit e então enxerga o texto.
create or replace function acervo.recusar_secao_com_texto_em_fonte_protegida() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  bloqueada boolean;
begin
  if new.fonte_id is distinct from old.fonte_id then
    select (f.obra_protegida or f.tipo_texto <> 'integral')
      into bloqueada
      from acervo.fonte f
     where f.id = new.fonte_id
       for share;
    if bloqueada and exists (select 1 from acervo.fonte_paragrafo p where p.secao_id = new.id) then
      raise exception 'texto integral recusado: a seção já tem parágrafo e não pode ir para obra protegida ou ficha'
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

revoke all on function acervo.recusar_secao_com_texto_em_fonte_protegida() from public;

drop trigger if exists fonte_secao_sem_texto_em_obra_protegida on acervo.fonte_secao;
create trigger fonte_secao_sem_texto_em_obra_protegida
  before update of fonte_id on acervo.fonte_secao
  for each row execute function acervo.recusar_secao_com_texto_em_fonte_protegida();
