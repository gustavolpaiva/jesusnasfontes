-- 0032 — Acervo: a aprovação do Grau fica amarrada ao CONTEÚDO, não só aos hashes (plano 02-24, revisão cruzada da fase,
-- duas ALTAS). Idempotente. Sem segredo. A 0028 já está aplicada e não é editada.
--
-- 1. `acervo.afirmacao.texto_hash` era uma coluna que quem escrevia mantinha de boa-fé. A carga (`jnf_carga`) tem `update`
--    na tabela: `update acervo.afirmacao set texto = 'outra frase'` deixava o hash velho, e a aprovação do Admin, amarrada a
--    ele, continuava valendo para um texto que ninguém aprovou. Agora o banco calcula o hash a cada escrita (como já faz
--    com `conteudo_hash` das fichas): `texto_hash = sha256(texto)`, sempre. Mudou o texto, mudou o hash, e a aprovação
--    deixa de valer sozinha (D-12), sem apagar nada. A linha que já estava com hash diferente do do próprio texto é
--    normalizada aqui.
--
-- 2. A Citação de parágrafo guarda o `trecho` literal que o Estudante lê, e a aprovação vale para ELE. Se o texto do parágrafo
--    mudasse depois (uma revisão nova do derivado, com a Fonte ainda publicada), o trecho guardado já não estaria no parágrafo
--    e a tela continuaria mostrando-o como citação literal. `acervo.citacoes_sustentadas` passa a exigir que o trecho, com os
--    espaços normalizados (a mesma regra de `normalizarEspaco`, que o validador de propostas aplica), continue dentro do
--    parágrafo. Sem trecho gravado (a tela já avisa que o trecho não pôde ser mostrado), a regra não se aplica.
--    `aprovar_afirmacao` e a política de linha já passam por essa função: a aprovação nova recusa (P0003) e a velha some.

-- ───────────────────────── 1. o hash do texto da Afirmação é do banco ─────────────────────────

create or replace function acervo.hash_do_texto_da_afirmacao() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.texto_hash := encode(sha256(convert_to(new.texto, 'UTF8')), 'hex');
  return new;
end
$$;

revoke all on function acervo.hash_do_texto_da_afirmacao() from public;

drop trigger if exists afirmacao_hash_do_texto on acervo.afirmacao;
create trigger afirmacao_hash_do_texto
  before insert or update on acervo.afirmacao
  for each row execute function acervo.hash_do_texto_da_afirmacao();

-- Linha com hash que não é o do próprio texto: o gatilho a corrige (o `update` abaixo só toca essas).
update acervo.afirmacao
   set texto = texto
 where texto_hash is distinct from encode(sha256(convert_to(texto, 'UTF8')), 'hex');

-- ───────────────────────── 2. o trecho da Citação continua no parágrafo ─────────────────────────

-- Igual a `normalizarEspaco` (TypeScript): todo espaço em branco do Unicode que `\s` cobre vira um espaço só, sem as pontas.
create or replace function acervo.espaco_normalizado(p_texto text) returns text
language sql immutable
set search_path = pg_catalog
as $$
  select btrim(
    regexp_replace(
      p_texto,
      '[[:space:]\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
      ' ',
      'g'),
    ' ')
$$;

revoke all on function acervo.espaco_normalizado(text) from public;
grant execute on function acervo.espaco_normalizado(text) to jnf_app, jnf_assistente, jnf_carga;

create or replace function acervo.citacoes_sustentadas(p_afirmacao text) returns boolean
language sql stable security definer
set search_path = pg_catalog
as $$
  select exists (select 1 from acervo.citacao c where c.afirmacao_id = p_afirmacao)
     and not exists (
       select 1
         from acervo.citacao c
        where c.afirmacao_id = p_afirmacao
          and (
            (c.ficha_item_id is not null and not exists (
               select 1
                 from acervo.ficha_item i
                 join acervo.ficha fi on fi.fonte_id = i.ficha_id
                 join acervo.verificacao_ficha v on v.ficha_id = fi.fonte_id and v.ficha_hash = fi.conteudo_hash
                where i.id = c.ficha_item_id))
            or
            (c.fonte_paragrafo_id is not null and not exists (
               select 1
                 from acervo.fonte_paragrafo p
                 join acervo.fonte_secao s on s.id = p.secao_id
                 join acervo.fonte o on o.id = s.fonte_id
                where p.id = c.fonte_paragrafo_id and o.tipo_texto = 'integral' and o.publicada
                  and (c.trecho is null
                       or strpos(acervo.espaco_normalizado(p.texto), acervo.espaco_normalizado(c.trecho)) > 0)))
          ))
$$;

revoke all on function acervo.citacoes_sustentadas(text) from public;
grant execute on function acervo.citacoes_sustentadas(text) to jnf_app, jnf_assistente, jnf_carga;
