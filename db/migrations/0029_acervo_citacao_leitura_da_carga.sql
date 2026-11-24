-- 0029 — Acervo: a carga LÊ a aprovação do Grau (só ler), para recusar texto e id de Afirmação aprovada (Pitfall 7).
-- Idempotente. Sem segredo. A 0028 já está aplicada e não é editada.
--
-- A 0028 ligou a política de linha em `acervo.aprovacao_afirmacao` e deu leitura só ao aplicativo e ao Assistente (com a
-- aprovação valendo) e ao Admin. `jnf_carga` tem `select` na tabela pelo privilégio padrão do esquema, mas SEM política
-- ele não vê linha alguma: o carregador de conteúdo não enxergaria que uma Afirmação tem aprovação e deixaria mudar o
-- texto ou remover o id por baixo dela. Esta política dá à carga a LEITURA (e só ela: insert, update e delete continuam
-- revogados na 0028, e nenhuma política de escrita existe para a carga). A aprovação não é segredo (grau e hashes).

drop policy if exists carga_le on acervo.aprovacao_afirmacao;
create policy carga_le on acervo.aprovacao_afirmacao for select to jnf_carga using (true);
