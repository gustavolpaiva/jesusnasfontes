-- 0013 — Anotação: a chave estrangeira de `privado.anotacao.estudo_id` para `conteudo.estudo` e os índices
-- do Caderno (plano 01-18; ANOT-01 a ANOT-03). Esta migração é a 0013 e não a 0009 que o plano previa:
-- os números 0009 a 0012 já estavam em uso. A tabela e a política `dono` vêm da 0001; nada aqui as muda.
-- Idempotente: pode ser aplicada de novo.

-- A ação é RESTRICT, ao contrário das chaves da posição, da conclusão e da Sessão: um Estudo que sai do
-- conteúdo NÃO leva embora o texto que a pessoa escreveu sobre ele. A carga de conteúdo que tentar remover
-- um Estudo com Anotação falha em voz alta, em vez de apagar o que é do Estudante. A restrição é só sobre
-- o `estudo_id` (um uuid): o banco repete a chave na mensagem de uma violação, nunca o corpo.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'anotacao_estudo_id_fkey' and conrelid = 'privado.anotacao'::regclass
  ) then
    alter table privado.anotacao
      add constraint anotacao_estudo_id_fkey
      foreign key (estudo_id) references conteudo.estudo (id) on delete restrict;
  end if;
end
$$;

-- A chave estrangeira confere `estudo_id` quando um Estudo é removido: sem índice, varreria a tabela.
create index if not exists anotacao_estudo_idx on privado.anotacao (estudo_id);

-- O Caderno lê as Anotações de uma pessoa, a mais recente primeiro.
create index if not exists anotacao_caderno_idx on privado.anotacao (estudante_id, atualizado_em desc);
