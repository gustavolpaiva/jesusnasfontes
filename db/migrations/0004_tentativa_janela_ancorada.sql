-- Limites de tentativa com janela ANCORADA no primeiro evento: uma linha por chave, que guarda o
-- início da janela. Antes a janela era um bloco fixo do relógio (chave, bloco), e na virada do
-- bloco cabia o dobro de pedidos ou de palpites. Os contadores são transitórios; recomeçar do
-- zero é seguro. Idempotente: pode rodar de novo sem efeito.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'admin.tentativa'::regclass and contype = 'p'
      and array_length(conkey, 1) = 2
  ) then
    delete from admin.tentativa;
    alter table admin.tentativa drop constraint tentativa_pkey;
    alter table admin.tentativa add primary key (chave);
  end if;
end $$;
