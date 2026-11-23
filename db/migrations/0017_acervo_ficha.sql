-- 0017 — Acervo: a ficha de uma obra protegida (ACER-03), a evidência de verificação sem escrita para
-- ninguém além das funções do banco (D-03) e a visibilidade por política de linha (ACER-07, D-02).
-- Idempotente: pode ser aplicada de novo. Sem segredo algum neste arquivo.
--
-- O contrato que esta migração fixa:
--   Uma ficha NASCE rascunho. "Verificada" não é coluna: é existir linha em `acervo.verificacao_ficha`
--   cujo `ficha_hash` é igual ao `conteudo_hash` ATUAL da ficha. Mudou o conteúdo, mudou o hash, e a
--   verificação deixa de valer em silêncio. Quem lê rascunho: só um Admin com segundo fator verificado
--   na geração atual da conta (`acervo.exigir_admin_mfa`), pelo papel do aplicativo.
--   Nem `jnf_carga` nem `jnf_app` têm escrita nas tabelas de evidência: só as funções de verificação
--   (plano 05), que são `security definer` de `jnf_migra`.
--
-- Limite honesto: isto impede o código de carga, o agente e o código de aplicação SEM sessão de Admin
-- viva. Não impede quem controla o papel `jnf_migra` nem um aplicativo comprometido que roube uma
-- sessão de Admin viva. É defesa em profundidade.
--
-- Onde mora cada dado de uma ficha: autor, título, Nível, slug e `limites_pt` ficam em `acervo.fonte`
-- (linha com tipo_texto 'ficha' e obra_protegida verdadeiro); `acervo.ficha` guarda edição consultada,
-- ano, editora, tese e o hash do conteúdo; `acervo.ficha_item` guarda argumentos e trechos com página.

-- ───────────────────────── ficha e itens ─────────────────────────

create table if not exists acervo.ficha (
  fonte_id uuid primary key references acervo.fonte (id),
  -- Página sem edição não é conferível: a edição consultada é obrigatória e não pode ser vazia.
  edicao_consultada text not null check (length(btrim(edicao_consultada)) > 0),
  ano smallint null check (ano is null or ano between 1 and 2100),
  editora text null,
  tese_pt text not null check (length(btrim(tese_pt)) > 0),
  -- De onde veio o rascunho: o Admin precisa saber se a página saiu da memória de um modelo.
  origem_do_rascunho text not null default 'memoria-do-modelo'
    check (origem_do_rascunho in ('memoria-do-modelo', 'consulta-direta')),
  idioma_trechos text not null default 'pt' check (idioma_trechos in ('pt', 'en')),
  conteudo_hash text not null check (conteudo_hash ~ '^[0-9a-f]{64}$'),
  atualizado_em timestamptz not null default now()
);

-- O id é `<slug da Fonte>/<tipo>-<n>`: estável pela ordem do item dentro do tipo.
create table if not exists acervo.ficha_item (
  id text primary key check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*/(argumento|trecho)-[0-9]+$'),
  ficha_id uuid not null references acervo.ficha (fonte_id) on delete cascade,
  tipo text not null check (tipo in ('argumento', 'trecho')),
  ordem smallint not null check (ordem > 0),
  -- D-19: tetos de tamanho no banco, para a ficha não virar o livro.
  texto_pt text not null check (length(btrim(texto_pt)) > 0 and char_length(texto_pt) <= 2000),
  pagina_inicio integer null check (pagina_inicio is null or pagina_inicio > 0),
  pagina_fim integer null check (pagina_fim is null or pagina_fim > 0),
  -- Página que não é número ("xi-xii"): texto livre, usado quando não há inteiro.
  pagina_texto text null check (pagina_texto is null or length(btrim(pagina_texto)) > 0),
  trecho_original text null check (trecho_original is null or char_length(trecho_original) <= 300),
  idioma_trecho text null check (idioma_trecho is null or idioma_trecho in ('pt', 'en')),
  confianca text not null check (confianca in ('alta', 'media', 'baixa')),
  conteudo_hash text not null check (conteudo_hash ~ '^[0-9a-f]{64}$'),
  unique (ficha_id, tipo, ordem),
  -- Argumento e trecho exigem página (inteira ou em texto); item sem página não é renderizado.
  constraint ficha_item_exige_pagina check (pagina_inicio is not null or pagina_texto is not null),
  constraint ficha_item_faixa_de_pagina
    check ((pagina_inicio is null) = (pagina_fim is null) and (pagina_inicio is null or pagina_fim >= pagina_inicio)),
  constraint ficha_item_trecho_tem_idioma check (trecho_original is null or idioma_trecho is not null)
);

create index if not exists ficha_item_por_ficha on acervo.ficha_item (ficha_id, tipo, ordem);

-- ───────────────────────── evidências (sem escrita para a aplicação) ─────────────────────────

-- O Admin conferiu esta página no livro, para ESTE hash do item. Item que muda volta a "a conferir".
create table if not exists acervo.conferencia_item (
  item_id text primary key references acervo.ficha_item (id) on delete cascade,
  item_hash text not null check (item_hash ~ '^[0-9a-f]{64}$'),
  conferida_em timestamptz not null default now()
);

-- O Admin verificou a ficha, para ESTE hash. O Estudante lê só `verificada_em` (D-05).
create table if not exists acervo.verificacao_ficha (
  ficha_id uuid primary key references acervo.ficha (fonte_id) on delete cascade,
  ficha_hash text not null check (ficha_hash ~ '^[0-9a-f]{64}$'),
  verificada_em timestamptz not null default now()
);

-- Quem agiu: o nome mora só aqui (D-05), no esquema que `jnf_carga` e `jnf_assistente` nem enxergam.
-- Apagar a conta do Admin não pode apagar o histórico: `por` fica nulo.
create table if not exists admin.registro_verificacao (
  id uuid primary key default gen_random_uuid(),
  acao text not null check (acao in ('conferir-item', 'verificar-ficha')),
  alvo text not null,
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  por uuid null references auth."user" (id) on delete set null,
  em timestamptz not null default now()
);

-- O privilégio padrão do esquema dá DML à carga (em `acervo`) e ao aplicativo (em `admin`). Aqui as
-- evidências ficam SEM escrita para os dois: logo depois de criar, antes de qualquer outra coisa.
revoke insert, update, delete, truncate on acervo.conferencia_item from jnf_carga, jnf_app, jnf_assistente;
revoke insert, update, delete, truncate on acervo.verificacao_ficha from jnf_carga, jnf_app, jnf_assistente;
revoke insert, update, delete, truncate on admin.registro_verificacao from jnf_carga, jnf_app, jnf_assistente;
-- `truncate` ignora a política de linha: nenhum papel de aplicação o tem em nenhuma tabela do Acervo.
revoke truncate on acervo.ficha, acervo.ficha_item, acervo.fonte, acervo.fonte_secao,
  acervo.fonte_paragrafo from jnf_carga, jnf_app, jnf_assistente;

-- ───────────────────────── prova de sessão de Admin com segundo fator ─────────────────────────

-- Mesma regra de `sessaoVerificada` (src/modules/identidade/sessao-mfa.ts): a sessão existe e não
-- venceu, a conta é de Admin e a marca de segundo fator é da geração ATUAL da conta (sem linha de
-- geração, a geração é 0). Devolve o id do usuário, ou nulo.
create or replace function acervo.exigir_admin_mfa(sessao uuid) returns uuid
language sql stable security definer
set search_path = pg_catalog
as $$
  select u.id
    from auth.session s
    join auth."user" u on u.id = s.user_id
    join admin.sessao_mfa m on m.session_id = s.id
   where s.id = sessao
     and s.expires_at > now()
     and u.role = 'admin'
     and m.geracao = coalesce(
       (select g.geracao from admin.segundo_fator_geracao g where g.user_id = u.id), 0)
$$;

revoke all on function acervo.exigir_admin_mfa(uuid) from public;
revoke all on function acervo.exigir_admin_mfa(uuid) from jnf_carga, jnf_assistente;
grant execute on function acervo.exigir_admin_mfa(uuid) to jnf_app;

-- ───────────────────────── política de linha ─────────────────────────
-- Sem `force`: o dono (jnf_migra) mantém acesso. Os outros papéis só veem o que uma política permite.
-- As políticas de seção e parágrafo herdam a da Fonte (a subconsulta passa pela política de quem
-- consulta), e a de item herda a da ficha. Não há ciclo: verificacao_ficha só tem `using (true)`.

alter table acervo.fonte enable row level security;
alter table acervo.fonte_secao enable row level security;
alter table acervo.fonte_paragrafo enable row level security;
alter table acervo.ficha enable row level security;
alter table acervo.ficha_item enable row level security;
alter table acervo.conferencia_item enable row level security;
alter table acervo.verificacao_ficha enable row level security;

-- A carga escreve conteúdo (nunca evidência, que não tem privilégio): vê tudo nas tabelas de conteúdo.
drop policy if exists carga_total on acervo.fonte;
create policy carga_total on acervo.fonte for all to jnf_carga using (true) with check (true);
drop policy if exists carga_total on acervo.fonte_secao;
create policy carga_total on acervo.fonte_secao for all to jnf_carga using (true) with check (true);
drop policy if exists carga_total on acervo.fonte_paragrafo;
create policy carga_total on acervo.fonte_paragrafo for all to jnf_carga using (true) with check (true);
drop policy if exists carga_total on acervo.ficha;
create policy carga_total on acervo.ficha for all to jnf_carga using (true) with check (true);
drop policy if exists carga_total on acervo.ficha_item;
create policy carga_total on acervo.ficha_item for all to jnf_carga using (true) with check (true);

-- A evidência de verificação não carrega nome nem conteúdo (só id, hash e data): é legível por quem
-- lê o Acervo, porque as políticas de ficha dependem dela. Ninguém escreve (privilégios revogados).
drop policy if exists leitura_da_evidencia on acervo.verificacao_ficha;
create policy leitura_da_evidencia on acervo.verificacao_ficha for select
  to jnf_app, jnf_assistente using (true);

-- Fonte de texto integral: só publicada.
drop policy if exists integral_publicada on acervo.fonte;
create policy integral_publicada on acervo.fonte for select to jnf_app, jnf_assistente
  using (tipo_texto = 'integral' and publicada);

-- Fonte de ficha: só com verificação cujo hash é o do conteúdo atual da ficha.
drop policy if exists ficha_verificada on acervo.fonte;
create policy ficha_verificada on acervo.fonte for select to jnf_app, jnf_assistente
  using (
    tipo_texto = 'ficha'
    and exists (
      select 1
        from acervo.ficha f
        join acervo.verificacao_ficha v on v.ficha_id = f.fonte_id and v.ficha_hash = f.conteudo_hash
       where f.fonte_id = fonte.id)
  );

drop policy if exists ficha_verificada on acervo.ficha;
create policy ficha_verificada on acervo.ficha for select to jnf_app, jnf_assistente
  using (
    exists (
      select 1 from acervo.verificacao_ficha v
       where v.ficha_id = ficha.fonte_id and v.ficha_hash = ficha.conteudo_hash)
  );

-- Seção, parágrafo e item herdam a visibilidade do pai.
drop policy if exists pela_fonte on acervo.fonte_secao;
create policy pela_fonte on acervo.fonte_secao for select to jnf_app, jnf_assistente
  using (exists (select 1 from acervo.fonte f where f.id = fonte_secao.fonte_id));

drop policy if exists pela_secao on acervo.fonte_paragrafo;
create policy pela_secao on acervo.fonte_paragrafo for select to jnf_app, jnf_assistente
  using (exists (select 1 from acervo.fonte_secao s where s.id = fonte_paragrafo.secao_id));

drop policy if exists pela_ficha on acervo.ficha_item;
create policy pela_ficha on acervo.ficha_item for select to jnf_app, jnf_assistente
  using (exists (select 1 from acervo.ficha f where f.fonte_id = ficha_item.ficha_id));

-- Rascunho do Admin: só o aplicativo, e só quando a transação carrega o id de uma sessão de Admin com
-- segundo fator verificado. A função é chamada em subconsulta escalar: uma vez por consulta (InitPlan),
-- nunca por linha candidata.
drop policy if exists rascunho_do_admin on acervo.fonte;
create policy rascunho_do_admin on acervo.fonte for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
drop policy if exists rascunho_do_admin on acervo.fonte_secao;
create policy rascunho_do_admin on acervo.fonte_secao for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
drop policy if exists rascunho_do_admin on acervo.fonte_paragrafo;
create policy rascunho_do_admin on acervo.fonte_paragrafo for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
drop policy if exists rascunho_do_admin on acervo.ficha;
create policy rascunho_do_admin on acervo.ficha for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
drop policy if exists rascunho_do_admin on acervo.ficha_item;
create policy rascunho_do_admin on acervo.ficha_item for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
-- A conferência é só do Admin: nem o Estudante nem o Assistente a leem.
drop policy if exists so_admin on acervo.conferencia_item;
create policy so_admin on acervo.conferencia_item for select to jnf_app
  using ((select acervo.exigir_admin_mfa(nullif(current_setting('app.sessao_admin', true), '')::uuid)) is not null);
