-- 0005 — uma linha de segundo fator por conta. A biblioteca grava com "procura, depois cria": duas
-- requisições simultâneas de cadastro criariam duas linhas e a conferência passaria a depender de
-- qual linha o banco devolve primeiro. O índice único faz a segunda criação falhar (23505) em vez
-- de duplicar. Idempotente. Sem segredo algum neste arquivo.
create unique index if not exists two_factor_user_id_unico on auth.two_factor (user_id);
