-- 0021 — Acervo: a busca bilíngue (ACER-05, SP-7). Idempotente: pode ser aplicada de novo. Sem segredo algum
-- neste arquivo. (O plano a chamava de 0019; as migrações 0016 a 0020 já existiam, e o número é este.)
--
-- Uma palavra em português, com ou sem acento, acha a Fonte em inglês porque a seção carrega o resumo e as
-- palavras-chave em português (D-18: auxiliar de busca, escrito por IA, nunca tradução); a palavra em inglês acha
-- pelo texto do parágrafo. Quatro colunas geradas (o banco as mantém sozinho, para todos os papéis) e um índice
-- GIN por coluna:
--
--   fonte_secao.tsv_pt       resumo e palavras-chave (peso A) e título (peso B), `public.pt_unaccent`
--   fonte_paragrafo.tsv_en   o texto do parágrafo, `english`, SÓ quando o parágrafo está em inglês
--   ficha.tsv_pt             a tese da ficha, `public.pt_unaccent`
--   ficha_item.tsv_pt        o texto de cada argumento e trecho da ficha, `public.pt_unaccent`
--
-- Quem pode ACHAR o quê não mora aqui: as políticas de linha da 0017 continuam valendo para quem consulta
-- (ficha só com verificação do conteúdo atual; texto integral só de Fonte publicada).
--
-- `array_to_string` é `stable` no catálogo (ela chama a função de saída do tipo do elemento) e uma coluna gerada
-- exige expressão imutável. Para `text[]` o resultado só depende do conteúdo, então o invólucro é honestamente
-- imutável. Sem `revoke`: é uma função pura de texto, e o papel que grava a coluna gerada precisa executá-la.

create or replace function acervo.juntar_palavras(p text[]) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$ select pg_catalog.array_to_string(p, ' ') $$;

-- ───────────────────────── seção: resumo, palavras-chave e título em português ─────────────────────────

alter table acervo.fonte_secao add column if not exists tsv_pt tsvector generated always as (
  setweight(to_tsvector('public.pt_unaccent', coalesce(resumo_pt, '')), 'A')
  || setweight(to_tsvector('public.pt_unaccent', coalesce(acervo.juntar_palavras(palavras_chave_pt), '')), 'A')
  || setweight(to_tsvector('public.pt_unaccent', coalesce(titulo, '')), 'B')
) stored;

create index if not exists fonte_secao_tsv_pt_gin on acervo.fonte_secao using gin (tsv_pt);

-- ───────────────────────── parágrafo: o texto em inglês ─────────────────────────

-- Só o parágrafo em inglês entra: o de outro idioma ficaria indexado com o radical errado (o resultado seria
-- ruído). Parágrafo sem idioma (nulo) herda o da Fonte na leitura; o carregador sempre o preenche.
alter table acervo.fonte_paragrafo add column if not exists tsv_en tsvector generated always as (
  case when idioma = 'en' then to_tsvector('english', texto) else ''::tsvector end
) stored;

create index if not exists fonte_paragrafo_tsv_en_gin on acervo.fonte_paragrafo using gin (tsv_en);

-- ───────────────────────── ficha: a tese e os itens ─────────────────────────

alter table acervo.ficha add column if not exists tsv_pt tsvector generated always as (
  to_tsvector('public.pt_unaccent', coalesce(tese_pt, ''))
) stored;

create index if not exists ficha_tsv_pt_gin on acervo.ficha using gin (tsv_pt);

alter table acervo.ficha_item add column if not exists tsv_pt tsvector generated always as (
  to_tsvector('public.pt_unaccent', coalesce(texto_pt, ''))
) stored;

create index if not exists ficha_item_tsv_pt_gin on acervo.ficha_item using gin (tsv_pt);

-- ───────────────────────── a porta de busca: candidatos pelo índice, sem a política de linha ─────────────────────────

-- ACHADO DO SP-7 (medido no Postgres 17 local): sob política de linha, o operador `@@` NÃO usa o índice GIN. O
-- planejador só empurra para o índice uma condição do usuário que seja `leakproof`, e `ts_match_vq` não é (nem
-- `gin_tsquery_consistent`); `leakproof` só um superusuário concede, e o Neon não o dá. Resultado: `jnf_app` lendo
-- `fonte_paragrafo` direto varre a tabela inteira (e roda a subconsulta da política em cada linha) em toda busca.
-- Desnormalizar `publicada` na linha não muda isto (qualquer política de linha, até `using (publicada)`, tira o
-- índice do caminho): a escolha aqui é entre varrer tudo e abrir UMA porta de leitura.
--
-- A porta: esta função devolve só IDENTIFICADORES e a posição de cada candidato (nenhum texto), já na ordem da
-- página pedida, de `security definer` do dono (que não passa pela política e por isso usa o GIN). A visibilidade que
-- ela aplica é a MESMA das políticas da 0017 e fica à vista aqui: texto integral só de Fonte publicada; ficha só com
-- verificação do conteúdo ATUAL (hash igual). Rascunho de Admin NÃO entra (a busca do Estudante nunca o mostra).
--
-- Defesa em profundidade: quem chama (`src/modules/acervo/busca.ts`) lê o título, o resumo e o texto por JUNÇÃO com
-- as tabelas, como `jnf_app`, então a política de linha vale de novo sobre tudo o que sai para a tela; um
-- erro desta função, no pior caso, deixa passar um identificador que a política depois recusa. Só `jnf_app` executa.

create or replace function acervo.buscar_candidatos(
  p_termo text, p_niveis text[], p_limite integer, p_desloc integer
) returns table (
  pos bigint, total bigint, tipo text, modo text,
  fonte_id uuid, secao_id text, par_id text, item_id text
)
language sql stable security definer
set search_path = pg_catalog
as $$
  with q as (
    select websearch_to_tsquery('public.pt_unaccent', p_termo) as pt,
           websearch_to_tsquery('english', p_termo) as en
  ),
  sec_pt as (
    select s.id as secao_id, ts_rank(s.tsv_pt, q.pt) as r
      from acervo.fonte_secao s, q
     where s.tsv_pt @@ q.pt
  ),
  par_en as (
    select distinct on (p.secao_id) p.secao_id, p.id as par_id, ts_rank(p.tsv_en, q.en) as r
      from acervo.fonte_paragrafo p, q
     where p.tsv_en @@ q.en
     order by p.secao_id, ts_rank(p.tsv_en, q.en) desc, p.ordem
  ),
  secoes as (
    select coalesce(a.secao_id, b.secao_id) as secao_id, b.par_id,
           case when b.secao_id is null or (a.secao_id is not null and a.r >= b.r)
                then 'resumo-pt' else 'texto-en' end as modo,
           greatest(coalesce(a.r, 0), coalesce(b.r, 0)) as r
      from sec_pt a full join par_en b on b.secao_id = a.secao_id
  ),
  cand_secao as (
    select 'secao'::text as tipo, x.modo, f.id as fonte_id, x.secao_id, x.par_id,
           null::text as item_id, x.r, f.titulo as ftitulo, s.ordem as sordem
      from secoes x
      join acervo.fonte_secao s on s.id = x.secao_id
      join acervo.fonte f on f.id = s.fonte_id
     where f.tipo_texto = 'integral' and f.publicada
       and (p_niveis is null or f.nivel = any (p_niveis))
  ),
  f_tese as (
    select fi.fonte_id, ts_rank(fi.tsv_pt, q.pt) as r
      from acervo.ficha fi, q
     where fi.tsv_pt @@ q.pt
  ),
  f_item as (
    select distinct on (i.ficha_id) i.ficha_id as fonte_id, i.id as item_id, ts_rank(i.tsv_pt, q.pt) as r
      from acervo.ficha_item i, q
     where i.tsv_pt @@ q.pt
     order by i.ficha_id, ts_rank(i.tsv_pt, q.pt) desc, i.id
  ),
  fichas as (
    select coalesce(t.fonte_id, i.fonte_id) as fonte_id,
           case when t.fonte_id is null or (i.fonte_id is not null and i.r > t.r)
                then i.item_id end as item_id,
           greatest(coalesce(t.r, 0), coalesce(i.r, 0)) as r
      from f_tese t full join f_item i on i.fonte_id = t.fonte_id
  ),
  cand_ficha as (
    select 'ficha'::text as tipo, 'ficha'::text as modo, f.id as fonte_id, null::text as secao_id,
           null::text as par_id, x.item_id, x.r, f.titulo as ftitulo, 0::smallint as sordem
      from fichas x
      join acervo.fonte f on f.id = x.fonte_id
     where f.tipo_texto = 'ficha'
       and (p_niveis is null or f.nivel = any (p_niveis))
       and exists (
         select 1
           from acervo.ficha fi
           join acervo.verificacao_ficha v on v.ficha_id = fi.fonte_id and v.ficha_hash = fi.conteudo_hash
          where fi.fonte_id = f.id)
  ),
  cand as (
    select * from cand_secao union all select * from cand_ficha
  ),
  ordenado as (
    select row_number() over (order by r desc, ftitulo, sordem, secao_id, fonte_id) as pos,
           count(*) over () as total, tipo, modo, fonte_id, secao_id, par_id, item_id
      from cand
  )
  select pos, total, tipo, modo, fonte_id, secao_id, par_id, item_id
    from ordenado
   where pos > p_desloc and pos <= p_desloc + p_limite
   order by pos
$$;

revoke all on function acervo.buscar_candidatos(text, text[], integer, integer) from public;
revoke all on function acervo.buscar_candidatos(text, text[], integer, integer) from jnf_carga, jnf_assistente;
grant execute on function acervo.buscar_candidatos(text, text[], integer, integer) to jnf_app;
