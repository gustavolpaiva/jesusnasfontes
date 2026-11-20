-- 0011 — Divergência entre tradições e perguntas por volta da Leitura contínua (conteúdo escrito por
-- nós, carregado por `pnpm content:load`). Moram em `conteudo`: o jnf_app só lê, o jnf_carga escreve
-- (privilégios padrão do bootstrap). Idempotente: cada objeto nasce com IF NOT EXISTS.
-- Esta migração é a 0011 e não a 0005 que o plano 01-12 previa: de 0005 a 0010 já estavam em uso.

-- Uma Divergência é um tema do Estudo e as leituras que as tradições dão a ele.
create table if not exists conteudo.divergencia (
  id uuid primary key default gen_random_uuid(),
  estudo_id uuid not null references conteudo.estudo (id) on delete cascade,
  ordem smallint not null check (ordem > 0),
  tema text not null,
  unique (estudo_id, ordem)
);

-- Cada leitura nomeia a tradição; a ordem de exibição é fixa no aplicativo (católica, ortodoxa,
-- protestante) e não depende da ordem em que as linhas foram escritas.
create table if not exists conteudo.divergencia_leitura (
  divergencia_id uuid not null references conteudo.divergencia (id) on delete cascade,
  tradicao text not null check (tradicao in ('catolica', 'ortodoxa', 'protestante')),
  resumo text not null,
  primary key (divergencia_id, tradicao)
);

-- Os três conjuntos de três perguntas da Leitura contínua: a volta v usa o conjunto (v - 1) mod 3.
create table if not exists conteudo.pergunta_volta (
  conjunto smallint not null check (conjunto between 0 and 2),
  ordem smallint not null check (ordem between 1 and 3),
  texto text not null,
  primary key (conjunto, ordem)
);
