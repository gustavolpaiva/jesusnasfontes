-- 0016 — Acervo: a Fonte, a seção e o parágrafo ganham identidade pública e proveniência (ACER-02, ACER-04,
-- ACER-09). Idempotente: pode ser aplicada de novo. Só `alter table` e `create ... if not exists`; as tabelas
-- de 0002 não são recriadas.
--
-- Contratos que esta migração fixa (citados por Citações e por âncoras de URL):
--   fonte.slug                      kebab-case, único: `josefo-antiguidades`
--   fonte_secao.id                  `<slug da Fonte>/<slug da seção>`: `josefo-antiguidades/18`
--   fonte_paragrafo.id              `<slug da Fonte>/<ref>` (ref pela numeração da obra): `josefo-antiguidades/18.63`

-- ───────────────────────── Fonte ─────────────────────────

alter table acervo.fonte add column if not exists slug text;
alter table acervo.fonte add column if not exists tipo_texto text not null default 'ficha';
alter table acervo.fonte add column if not exists idioma text not null default 'pt';
alter table acervo.fonte add column if not exists epoca text null;
alter table acervo.fonte add column if not exists origem_nome text null;
alter table acervo.fonte add column if not exists origem_url text null;
alter table acervo.fonte add column if not exists licenca_url text null;
alter table acervo.fonte add column if not exists tradutor text null;
alter table acervo.fonte add column if not exists traducao_ano smallint null;
alter table acervo.fonte add column if not exists edicao text null;
alter table acervo.fonte add column if not exists traduzida_por_nos boolean not null default false;
alter table acervo.fonte add column if not exists limites_pt text null;
alter table acervo.fonte add column if not exists publicada boolean not null default false;
alter table acervo.fonte add column if not exists origem_registro text not null default 'arquivo';
alter table acervo.fonte add column if not exists conjunto_id text null references acervo.conjunto_dados (id);

-- `licenca` (de 0002) passa a ser o CÓDIGO da licença do texto: `dominio-publico`, `cc-by-sa-4.0`...

-- A Fonte sem endereço não existe para o Estudante: o slug é obrigatório (a tabela nasceu vazia).
alter table acervo.fonte alter column slug set not null;

create unique index if not exists fonte_slug_unico on acervo.fonte (slug);

alter table acervo.fonte drop constraint if exists fonte_slug_formato;
alter table acervo.fonte add constraint fonte_slug_formato
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

alter table acervo.fonte drop constraint if exists fonte_tipo_texto_valido;
alter table acervo.fonte add constraint fonte_tipo_texto_valido
  check (tipo_texto in ('integral', 'ficha'));

alter table acervo.fonte drop constraint if exists fonte_idioma_valido;
alter table acervo.fonte add constraint fonte_idioma_valido
  check (idioma in ('pt', 'en'));

alter table acervo.fonte drop constraint if exists fonte_origem_registro_valida;
alter table acervo.fonte add constraint fonte_origem_registro_valida
  check (origem_registro in ('arquivo', 'painel'));

-- ACER-09: obra protegida nunca tem texto integral. A regra mora no banco, não só na tela.
alter table acervo.fonte drop constraint if exists fonte_obra_protegida_sem_texto_integral;
alter table acervo.fonte add constraint fonte_obra_protegida_sem_texto_integral
  check (not (obra_protegida and tipo_texto = 'integral'));

-- ACER-09 (portão de licença): texto integral exige código de licença e origem em https. `coalesce`
-- porque `null ~ ...` é nulo, e uma restrição de linha deixa passar o que dá nulo.
alter table acervo.fonte drop constraint if exists fonte_texto_integral_exige_licenca_e_origem;
alter table acervo.fonte add constraint fonte_texto_integral_exige_licenca_e_origem
  check (
    tipo_texto <> 'integral'
    or (
      coalesce(length(licenca), 0) > 0
      and coalesce(origem_url ~ '^https://', false)
    )
  );

-- ───────────────────────── seção ─────────────────────────

alter table acervo.fonte_secao add column if not exists slug text;
alter table acervo.fonte_secao add column if not exists ref_inicio integer null;
alter table acervo.fonte_secao add column if not exists ref_fim integer null;
-- Resumo e palavras-chave em português (D-18): auxiliar de busca, escrito por IA, nunca tradução.
alter table acervo.fonte_secao add column if not exists resumo_pt text null;
alter table acervo.fonte_secao add column if not exists palavras_chave_pt text[] not null default '{}';

alter table acervo.fonte_secao alter column slug set not null;
create unique index if not exists fonte_secao_slug_unico on acervo.fonte_secao (fonte_id, slug);

alter table acervo.fonte_secao drop constraint if exists fonte_secao_slug_formato;
alter table acervo.fonte_secao add constraint fonte_secao_slug_formato
  check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

alter table acervo.fonte_secao drop constraint if exists fonte_secao_faixa_valida;
alter table acervo.fonte_secao add constraint fonte_secao_faixa_valida
  check ((ref_inicio is null) = (ref_fim is null) and (ref_inicio is null or ref_fim >= ref_inicio));

-- ───────────────────────── parágrafo ─────────────────────────

-- `ref` é a numeração da obra (18.63), nunca a posição no arquivo. `ref_inicio..ref_fim` é a faixa da
-- numeração padrão que a unidade da tradução cobre (Whiston 20.197 cobre Niese 197 a 203).
alter table acervo.fonte_paragrafo add column if not exists ref text;
alter table acervo.fonte_paragrafo add column if not exists ref_inicio integer null;
alter table acervo.fonte_paragrafo add column if not exists ref_fim integer null;
alter table acervo.fonte_paragrafo add column if not exists idioma text null;
-- Notas de editor ficam fora de `texto`, em campo próprio.
alter table acervo.fonte_paragrafo add column if not exists notas jsonb not null default '[]'::jsonb;

alter table acervo.fonte_paragrafo alter column ref set not null;

alter table acervo.fonte_paragrafo drop constraint if exists fonte_paragrafo_ref_formato;
alter table acervo.fonte_paragrafo add constraint fonte_paragrafo_ref_formato
  check (ref ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$');

alter table acervo.fonte_paragrafo drop constraint if exists fonte_paragrafo_idioma_valido;
alter table acervo.fonte_paragrafo add constraint fonte_paragrafo_idioma_valido
  check (idioma is null or idioma in ('pt', 'en'));

alter table acervo.fonte_paragrafo drop constraint if exists fonte_paragrafo_faixa_valida;
alter table acervo.fonte_paragrafo add constraint fonte_paragrafo_faixa_valida
  check ((ref_inicio is null) = (ref_fim is null) and (ref_inicio is null or ref_fim >= ref_inicio));
