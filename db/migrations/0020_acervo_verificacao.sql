-- 0020 — Acervo: as duas únicas portas que gravam evidência de verificação (ACER-07, D-02, D-03, D-05).
-- Idempotente: pode ser aplicada de novo. Sem segredo algum neste arquivo.
--
--   acervo.conferir_item(sessao, item, hash)   o Admin conferiu esta página no livro, para ESTE hash do item
--   acervo.verificar_ficha(sessao, ficha, hash) o Admin verificou a ficha, para ESTE hash da ficha
--
-- Ambas são `security definer` de jnf_migra, reexigem a sessão de um Admin com segundo fator
-- (`acervo.exigir_admin_mfa`, 42501 se não houver) e só `jnf_app` as executa. Nenhuma outra porta grava nas tabelas
-- de evidência (privilégios revogados na 0017) e NENHUMA função desfaz conferência ou verificação: corrigir uma ficha
-- verificada é editar o arquivo e recarregar; o hash muda e a verificação deixa de valer sozinha.
--
-- Códigos de erro (o painel os distingue sem ler texto do banco):
--   42501  sessão sem segundo fator (inexistente, vencida, de Estudante ou de geração antiga)
--   40001  o item ou a ficha mudou desde a leitura (hash velho), ou deixou de existir
--   P0001  faltam páginas a conferir; a contagem vai no NOME DA RESTRIÇÃO do erro (`faltam_<n>`), que é o único
--          campo além do SQLSTATE que a camada de banco deixa chegar ao código (`erro-banco.ts`)
--   P0002  a edição consultada ainda é "A confirmar": a página só vale para uma edição declarada
--   0A000  transação fora de READ COMMITTED (a decisão lê outras linhas; ver 0019)
--
-- Concorrência (herdada da correção do plano 02-02): o hash gravado como evidência é SEMPRE o que o banco calculou e
-- guardou na linha TRAVADA da ficha (`for update`), nunca o que o chamador enviou: o parâmetro `p_hash` só diz qual
-- conteúdo o Admin viu e é comparado com o hash travado. Toda mudança de item, de ficha ou de campo da Fonte que o
-- hash cobre ESCREVE a linha da ficha (gatilhos da 0018), então uma mudança concorrente espera esta transação e, ao
-- acordar, recalcula; e uma mudança já em curso faz esta esperar, reler o hash novo e recusar com 40001. Em nenhum
-- caso fica evidência amarrada a conteúdo velho que alguém tenha enviado.

-- ───────────────────────── registro interno de quem agiu ─────────────────────────

-- O nome mora só aqui (D-05). Jnf_carga e jnf_assistente nem enxergam o esquema `admin`; o aplicativo só lê, e só com
-- a sessão de um Admin com segundo fator; ninguém da aplicação escreve (privilégios revogados na 0017).
alter table admin.registro_verificacao enable row level security;

drop policy if exists so_admin on admin.registro_verificacao;
create policy so_admin on admin.registro_verificacao for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);

-- ───────────────────────── conferir_item ─────────────────────────

create or replace function acervo.conferir_item(p_sessao uuid, p_item text, p_hash text) returns void
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

  -- Trava o item (FOR SHARE): uma mudança concorrente do item espera esta transação, e uma já em curso faz esta
  -- esperar e reler o hash novo.
  select i.conteudo_hash into v_hash from acervo.ficha_item i where i.id = p_item for share;
  if v_hash is null or v_hash is distinct from p_hash then
    raise exception 'o item mudou desde a leitura' using errcode = '40001';
  end if;

  -- O hash gravado é o lido do banco com a linha travada, nunca o parâmetro.
  insert into acervo.conferencia_item (item_id, item_hash) values (p_item, v_hash)
    on conflict (item_id) do update set item_hash = excluded.item_hash, conferida_em = now();
  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('conferir-item', p_item, v_hash, v_admin);
end
$$;

revoke all on function acervo.conferir_item(uuid, text, text) from public;
revoke all on function acervo.conferir_item(uuid, text, text) from jnf_carga, jnf_assistente;
grant execute on function acervo.conferir_item(uuid, text, text) to jnf_app;

-- ───────────────────────── verificar_ficha ─────────────────────────

create or replace function acervo.verificar_ficha(p_sessao uuid, p_ficha uuid, p_hash text) returns void
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  v_admin uuid;
  v_hash text;
  v_edicao text;
  v_slug text;
  v_faltam integer;
begin
  v_admin := acervo.exigir_admin_mfa(p_sessao);
  if v_admin is null then
    raise exception 'sessão sem segundo fator' using errcode = '42501';
  end if;
  perform acervo.exigir_leitura_confirmada();

  -- Trava a linha da ficha ANTES de ler o hash que vira evidência. Toda mudança de conteúdo escreve esta linha, então
  -- ela não muda sob esta transação; se estava mudando, a leitura espera o commit e devolve o hash novo.
  select f.conteudo_hash, f.edicao_consultada, o.slug
    into v_hash, v_edicao, v_slug
    from acervo.ficha f
    join acervo.fonte o on o.id = f.fonte_id
   where f.fonte_id = p_ficha
     for update of f;
  if v_hash is null or v_hash is distinct from p_hash then
    raise exception 'a ficha mudou desde a leitura' using errcode = '40001';
  end if;

  if v_edicao ilike 'a confirmar%' then
    raise exception 'a edição consultada ainda não foi confirmada' using errcode = 'P0002';
  end if;

  -- Todo item com página precisa de conferência do hash ATUAL do item (item mudado volta a "a conferir").
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

  -- O hash gravado é o da linha travada (calculado pelo banco), nunca o parâmetro.
  insert into acervo.verificacao_ficha (ficha_id, ficha_hash) values (p_ficha, v_hash)
    on conflict (ficha_id) do update set ficha_hash = excluded.ficha_hash, verificada_em = now();
  insert into admin.registro_verificacao (acao, alvo, hash, por)
    values ('verificar-ficha', v_slug, v_hash, v_admin);
end
$$;

revoke all on function acervo.verificar_ficha(uuid, uuid, text) from public;
revoke all on function acervo.verificar_ficha(uuid, uuid, text) from jnf_carga, jnf_assistente;
grant execute on function acervo.verificar_ficha(uuid, uuid, text) to jnf_app;
