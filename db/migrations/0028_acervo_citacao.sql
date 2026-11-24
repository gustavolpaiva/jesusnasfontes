-- 0028 — Acervo: a Citação com três alvos e a aprovação do Grau de certeza amarrada a hash (ACER-06, ACER-10, D-04, D-10,
-- D-11, D-12, D-16). Idempotente: pode ser aplicada de novo. Sem segredo algum neste arquivo.
--
-- O contrato que esta migração fixa:
--   1. Uma Citação aponta para EXATAMENTE UM alvo: um parágrafo de Fonte, um item de ficha ou uma Passagem bíblica
--      (intervalo de versículos; a Bíblia nunca vira Fonte duplicada, D-16).
--   2. O Grau de certeza e a Citação só chegam ao Estudante por `acervo.aprovacao_afirmacao`, que ninguém da aplicação
--      escreve (nem a carga, nem o aplicativo sem a função): só `acervo.aprovar_afirmacao`, que reexige a sessão de Admin
--      com segundo fator (D-04). "Aprovada" não é coluna: é existir linha cujo `texto_hash` é o do texto ATUAL da
--      Afirmação e cujo `citacoes_hash` é o do conjunto ATUAL de Citações, e cujos alvos ainda sustentam a Citação
--      (ficha verificada com o hash atual, Fonte integral publicada). Mudou o texto, o conjunto ou o estado do alvo, e a
--      Afirmação volta sozinha a "Fonte em preparação" (D-12), sem apagar nada.
--   3. O hash do conjunto de Citações é calculado AQUI, no banco (`acervo.hash_citacoes`), nunca duplicado em TypeScript.
--
-- Concorrência (lições dos planos 17 e 18): a checagem e a escrita de `aprovar_afirmacao` acontecem na MESMA transação,
-- depois de travar a linha da Afirmação (`for update`); todo insert, update ou delete de Citação trava a mesma linha
-- (gatilho), de modo que uma mudança do conjunto em curso faz a aprovação esperar e ver o hash novo (40001), e uma
-- aprovação em curso faz a mudança esperar. A decisão lê outras linhas, então exige READ COMMITTED (`0A000`, ver 0019).
--
-- Códigos de erro de `aprovar_afirmacao`:
--   42501  sessão sem segundo fator (inexistente, vencida, de Estudante ou de geração antiga)
--   22023  Grau fora da lista fechada
--   40001  o texto da Afirmação ou o conjunto de Citações mudou desde a leitura (hash velho), ou a Afirmação não existe
--   P0002  a Afirmação não tem nenhuma Citação
--   P0003  alguma Citação aponta para alvo que não sustenta: ficha não verificada ou Fonte não publicada
--   0A000  transação fora de READ COMMITTED

-- ───────────────────────── Citação: três alvos ─────────────────────────

alter table acervo.citacao alter column fonte_paragrafo_id drop not null;
alter table acervo.citacao add column if not exists ficha_item_id text null references acervo.ficha_item (id);
alter table acervo.citacao add column if not exists versiculo_inicio integer null references acervo.versiculo (id);
alter table acervo.citacao add column if not exists versiculo_fim integer null references acervo.versiculo (id);
alter table acervo.citacao add column if not exists ordem smallint null;

-- Linhas de antes desta migração (a carga nunca gravou Citação, mas a migração não pode depender disso): ordem pela
-- criação, dentro da Afirmação.
update acervo.citacao c set ordem = n.ordem
  from (select id, (row_number() over (partition by afirmacao_id order by criada_em, id))::smallint as ordem
          from acervo.citacao where ordem is null) n
 where c.id = n.id;
alter table acervo.citacao alter column ordem set not null;
alter table acervo.citacao drop constraint if exists citacao_ordem_positiva;
alter table acervo.citacao add constraint citacao_ordem_positiva check (ordem > 0);

alter table acervo.citacao drop constraint if exists citacao_um_alvo;
alter table acervo.citacao add constraint citacao_um_alvo check (
  num_nonnulls(fonte_paragrafo_id, ficha_item_id, versiculo_inicio) = 1
  and (versiculo_inicio is null) = (versiculo_fim is null)
  and (versiculo_inicio is null or versiculo_fim >= versiculo_inicio)
);

-- D-19: o trecho curto de ficha cabe em 300 caracteres, imposto no banco (a ficha não vira o livro).
alter table acervo.citacao drop constraint if exists citacao_trecho_de_ficha_curto;
alter table acervo.citacao add constraint citacao_trecho_de_ficha_curto
  check (ficha_item_id is null or trecho is null or char_length(trecho) <= 300);

alter table acervo.citacao drop constraint if exists citacao_idioma_valido;
alter table acervo.citacao add constraint citacao_idioma_valido check (idioma is null or idioma in ('pt', 'en'));

alter table acervo.citacao drop constraint if exists citacao_ordem_unica;
alter table acervo.citacao add constraint citacao_ordem_unica unique (afirmacao_id, ordem);

create index if not exists citacao_por_afirmacao on acervo.citacao (afirmacao_id, ordem);

-- ───────────────────────── propostas e aprovações ─────────────────────────

-- O agente propõe (D-04); a carga grava. Só o Admin com segundo fator lê: a justificativa não é do Estudante.
create table if not exists acervo.proposta_grau (
  afirmacao_id text primary key references acervo.afirmacao (id),
  grau_proposto text not null check (grau_proposto in ('consenso', 'posicao-majoritaria', 'disputada')),
  justificativa text not null check (length(btrim(justificativa)) > 0),
  texto_hash text not null check (texto_hash ~ '^[0-9a-f]{64}$'),
  proposta_em timestamptz not null default now()
);

-- A aprovação do dono: sem escrita para ninguém da aplicação. Só `aprovar_afirmacao` grava.
create table if not exists acervo.aprovacao_afirmacao (
  afirmacao_id text primary key references acervo.afirmacao (id),
  texto_hash text not null check (texto_hash ~ '^[0-9a-f]{64}$'),
  grau text not null check (grau in ('consenso', 'posicao-majoritaria', 'disputada')),
  citacoes_hash text not null check (citacoes_hash ~ '^[0-9a-f]{64}$'),
  aprovada_em timestamptz not null default now()
);

-- Logo depois de criar, antes de qualquer outra coisa (como na 0017): a aprovação fica SEM escrita para os três papéis,
-- e nenhum papel da aplicação tem `truncate`.
revoke insert, update, delete, truncate on acervo.aprovacao_afirmacao from jnf_carga, jnf_app, jnf_assistente;
revoke truncate on acervo.proposta_grau, acervo.citacao from jnf_carga, jnf_app, jnf_assistente;
-- A proposta nunca é escrita pelo aplicativo (o Admin a lê e a aprova pela função), só pela carga.
revoke insert, update, delete on acervo.proposta_grau from jnf_app, jnf_assistente;

-- O registro interno (D-05) ganha a ação da aprovação. A restrição de ação é recriada com as da 0022 mais a nova.
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
    'conferir-item', 'verificar-ficha', 'salvar-fonte', 'salvar-secao', 'salvar-resumo', 'reverter-fonte',
    'aprovar-afirmacao'));

-- ───────────────────────── o hash do conjunto de Citações ─────────────────────────

-- sha256 de um JSON canônico das Citações ordenadas: ordem, alvo (tipo e id), trecho e idioma. Vazio dá um hash fixo
-- (a função de aprovação recusa conjunto vazio; aqui o hash de "nenhuma" nunca é nulo). Lê a tabela sem depender da
-- política de linha de quem consulta.
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
             || acervo.json_de_texto(c.trecho) || ','
             || acervo.json_de_texto(c.idioma) || ']',
         ',' order by c.ordem), '')
    || ']', 'UTF8')), 'hex')
  from acervo.citacao c
 where c.afirmacao_id = p_afirmacao
$$;

revoke all on function acervo.hash_citacoes(text) from public;
grant execute on function acervo.hash_citacoes(text) to jnf_app, jnf_assistente, jnf_carga;

-- Todos os alvos ainda sustentam a Citação, e há ao menos uma: ficha verificada para o hash ATUAL dela, Fonte de texto
-- integral publicada, Passagem bíblica (sempre sustenta). Fonte do estado vivo do alvo: nada é gravado.
create or replace function acervo.citacoes_sustentadas(p_afirmacao text) returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select exists (select 1 from acervo.citacao c where c.afirmacao_id = p_afirmacao)
     and not exists (
       select 1
         from acervo.citacao c
        where c.afirmacao_id = p_afirmacao
          and (
            (c.ficha_item_id is not null and not exists (
               select 1
                 from acervo.ficha_item i
                 join acervo.ficha fi on fi.fonte_id = i.ficha_id
                 join acervo.verificacao_ficha v on v.ficha_id = fi.fonte_id and v.ficha_hash = fi.conteudo_hash
                where i.id = c.ficha_item_id))
            or
            (c.fonte_paragrafo_id is not null and not exists (
               select 1
                 from acervo.fonte_paragrafo p
                 join acervo.fonte_secao s on s.id = p.secao_id
                 join acervo.fonte o on o.id = s.fonte_id
                where p.id = c.fonte_paragrafo_id and o.tipo_texto = 'integral' and o.publicada))
          ))
$$;

revoke all on function acervo.citacoes_sustentadas(text) from public;
grant execute on function acervo.citacoes_sustentadas(text) to jnf_app, jnf_assistente, jnf_carga;

-- A aprovação VALE: há linha, o texto e o conjunto de Citações são os da aprovação e os alvos sustentam. Uma regra só,
-- usada pelas políticas de linha de `citacao` e de `aprovacao_afirmacao`.
create or replace function acervo.aprovacao_vale(p_afirmacao text) returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select exists (
    select 1
      from acervo.aprovacao_afirmacao a
      join acervo.afirmacao f on f.id = a.afirmacao_id
     where a.afirmacao_id = p_afirmacao
       and a.texto_hash = f.texto_hash
       and a.citacoes_hash = acervo.hash_citacoes(f.id)
       and acervo.citacoes_sustentadas(f.id))
$$;

revoke all on function acervo.aprovacao_vale(text) from public;
grant execute on function acervo.aprovacao_vale(text) to jnf_app, jnf_assistente, jnf_carga;

-- ───────────────────────── trava: toda mudança de Citação trava a Afirmação ─────────────────────────

create or replace function acervo.travar_afirmacao_da_citacao() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform 1 from acervo.afirmacao a where a.id = old.afirmacao_id for update;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform 1 from acervo.afirmacao a where a.id = new.afirmacao_id for update;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

revoke all on function acervo.travar_afirmacao_da_citacao() from public;

drop trigger if exists citacao_trava_afirmacao on acervo.citacao;
create trigger citacao_trava_afirmacao
  before insert or update or delete on acervo.citacao
  for each row execute function acervo.travar_afirmacao_da_citacao();

-- ───────────────────────── aprovar_afirmacao: a única porta que grava a aprovação ─────────────────────────

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

  v_citacoes_hash := acervo.hash_citacoes(p_afirmacao);
  if v_citacoes_hash is distinct from p_citacoes_hash then
    raise exception 'o conjunto de Citações mudou desde a leitura' using errcode = '40001';
  end if;

  if not exists (select 1 from acervo.citacao c where c.afirmacao_id = p_afirmacao) then
    raise exception 'a Afirmação não tem Citação' using errcode = 'P0002';
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

-- ───────────────────────── política de linha ─────────────────────────
-- Sem `force`: o dono (jnf_migra) mantém acesso. Mesmo molde da 0017.

alter table acervo.citacao enable row level security;
alter table acervo.aprovacao_afirmacao enable row level security;
alter table acervo.proposta_grau enable row level security;

-- A carga escreve Citação e proposta (nunca aprovação: sem privilégio, e sem política).
drop policy if exists carga_total on acervo.citacao;
create policy carga_total on acervo.citacao for all to jnf_carga using (true) with check (true);
drop policy if exists carga_total on acervo.proposta_grau;
create policy carga_total on acervo.proposta_grau for all to jnf_carga using (true) with check (true);

-- O Estudante e o Assistente leem a Citação e a aprovação só quando a aprovação vale.
drop policy if exists aprovada on acervo.citacao;
create policy aprovada on acervo.citacao for select to jnf_app, jnf_assistente
  using (acervo.aprovacao_vale(afirmacao_id));
drop policy if exists aprovacao_valida on acervo.aprovacao_afirmacao;
create policy aprovacao_valida on acervo.aprovacao_afirmacao for select to jnf_app, jnf_assistente
  using (acervo.aprovacao_vale(afirmacao_id));

-- O Admin com segundo fator lê tudo (inclusive a aprovação velha e a proposta), para a lista do dono (plano 21).
drop policy if exists do_admin on acervo.citacao;
create policy do_admin on acervo.citacao for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
drop policy if exists do_admin on acervo.aprovacao_afirmacao;
create policy do_admin on acervo.aprovacao_afirmacao for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
drop policy if exists so_admin on acervo.proposta_grau;
create policy so_admin on acervo.proposta_grau for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
