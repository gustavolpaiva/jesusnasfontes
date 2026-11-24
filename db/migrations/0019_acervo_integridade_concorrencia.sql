-- 0019 — Acervo: os gatilhos de ACER-09 só decidem em READ COMMITTED. Fecha o achado ALTA da segunda rodada da
-- revisão cruzada do plano 02-02 (0017 e 0018 já estão aplicadas e não são editadas). Idempotente. Sem segredo.
--
-- O problema: três gatilhos decidem olhando OUTRAS linhas (o parágrafo olha a Fonte da seção; a mudança de Fonte da
-- seção olha os parágrafos dela; virar protegida olha os parágrafos da Fonte). Em REPEATABLE READ e SERIALIZABLE a
-- consulta do gatilho usa o retrato (snapshot) do começo da transação: um parágrafo que outra transação confirmou
-- DEPOIS desse retrato não é visto, e a trava FOR SHARE da 0018 não escreve na linha, então o banco não acusa
-- conflito de serialização. Resultado: texto integral sob obra protegida.
--
-- A decisão: esses gatilhos exigem READ COMMITTED e recusam qualquer outro nível (0A000). Em READ COMMITTED cada
-- consulta do gatilho tem retrato novo e as travas da 0018 fazem a transação concorrente esperar e reler, o que
-- já está provado em teste. Recusar é mais simples e mais fácil de provar do que manter contador na linha-pai, e
-- nenhum caminho do produto escreve parágrafo, seção ou marca de Fonte fora de READ COMMITTED (o nível padrão).
--
-- O hash da ficha (0018) NÃO precisa disto: toda mudança de ficha, item ou campo da Fonte ESCREVE a linha da ficha
-- (gatilhos), então duas transações em REPEATABLE READ/SERIALIZABLE que mexem na mesma ficha conflitam por escrita
-- (40001) em vez de gravar hash calculado sobre retrato velho. Teste cobre os dois níveis.

create or replace function acervo.exigir_leitura_confirmada() returns void
language plpgsql
set search_path = pg_catalog
as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'texto integral: esta escrita exige READ COMMITTED (a checagem de outras linhas não vê o que foi confirmado depois do retrato da transação)'
      using errcode = '0A000';
  end if;
end
$$;

revoke all on function acervo.exigir_leitura_confirmada() from public;

-- Parágrafo: lê a seção e a Fonte.
create or replace function acervo.recusar_texto_integral_protegido() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  bloqueada boolean;
begin
  perform acervo.exigir_leitura_confirmada();
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

-- Seção que troca de Fonte: lê a Fonte de destino e os parágrafos da seção.
create or replace function acervo.recusar_secao_com_texto_em_fonte_protegida() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
declare
  bloqueada boolean;
begin
  if new.fonte_id is distinct from old.fonte_id then
    perform acervo.exigir_leitura_confirmada();
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

-- Fonte que vira protegida ou de ficha: lê os parágrafos dela. Virar de volta a texto integral não lê nada.
create or replace function acervo.recusar_fonte_protegida_com_texto() returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $$
begin
  if new.obra_protegida or new.tipo_texto <> 'integral' then
    perform acervo.exigir_leitura_confirmada();
    if exists (
      select 1
        from acervo.fonte_secao s
        join acervo.fonte_paragrafo p on p.secao_id = s.id
       where s.fonte_id = new.id
    ) then
      raise exception 'texto integral recusado: a Fonte já tem parágrafo e não pode virar obra protegida ou ficha'
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

revoke all on function acervo.recusar_fonte_protegida_com_texto() from public;
