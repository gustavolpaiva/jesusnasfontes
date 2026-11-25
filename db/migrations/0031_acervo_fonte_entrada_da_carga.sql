-- 0031 — Acervo: a Fonte guarda de QUAL ENTRADA da carga ela veio, e não só de qual derivado (plano 02-22, segunda revisão
-- cruzada). Idempotente. Sem segredo. A 0030 já está aplicada e não é editada.
--
-- A 0030 guardava a revisão e o sha256 do DERIVADO. Uma versão que corrige só o YAML (título, licença, resumo) e mantém o
-- derivado tinha a mesma revisão e o mesmo sha256: o build de uma versão anterior passava pela guarda e sobrescrevia os
-- campos corrigidos. A entrada passa a ser o derivado MAIS o YAML normalizado: `entrada_revisao` é a revisão monótona do
-- lock (sobe quando qualquer um dos dois muda) e `entrada_sha256`, o sha256 dos dois juntos.
--
-- As colunas são renomeadas e os valores gravados, que tinham outro significado (só o derivado), são limpos: a próxima carga
-- os registra de novo pelo sentido novo. Fonte sem registro é aceita na primeira passagem (como a anterior à 0030).

do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'acervo' and table_name = 'fonte' and column_name = 'derivado_revisao'
  ) then
    alter table acervo.fonte rename column derivado_revisao to entrada_revisao;
    alter table acervo.fonte rename column derivado_sha256 to entrada_sha256;
    alter table acervo.fonte rename constraint fonte_derivado_revisao_valida to fonte_entrada_revisao_valida;
    alter table acervo.fonte rename constraint fonte_derivado_sha256_valido to fonte_entrada_sha256_valido;
    alter table acervo.fonte rename constraint fonte_derivado_versao_junta to fonte_entrada_versao_junta;
    update acervo.fonte set entrada_revisao = null, entrada_sha256 = null;
  end if;
end
$$;
