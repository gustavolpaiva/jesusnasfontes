-- 0014 — Anotação: a ORDEM das escritas passa a ser do servidor (plano 01-18, revisão da rodada 10).
-- Idempotente: pode ser aplicada de novo.
--
-- Cada montagem do editor (uma aba, uma abertura do Estudo) é um escritor com um id e um número de envio que
-- só cresce. A linha guarda qual escritor gravou por último (`montagem`) e o número desse envio (`seq`): um
-- envio mais velho do mesmo escritor, que chegue atrasado (resposta perdida, rede lenta), é recusado; um
-- envio mais novo do mesmo escritor continua o que ele mesmo gravou, mesmo que ele não tenha recebido a
-- resposta. Assim o navegador nunca precisa adivinhar se um envio chegou.
--
-- Apagar o texto passa a guardar a linha com o corpo vazio, em vez de apagá-la: sem a linha, não haveria onde
-- lembrar a ordem, e um envio velho do texto apagado ressuscitaria a Anotação. O Caderno ignora a linha vazia.
-- Nenhuma restrição de verificação (o banco repetiria a linha, com o texto, numa violação).
alter table privado.anotacao add column if not exists montagem uuid;
alter table privado.anotacao add column if not exists seq integer not null default 0;
