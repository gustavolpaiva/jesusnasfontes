#!/usr/bin/env bash
# Portão de publicação: prova que um repositório pode ir a público.
# Uso: check-public-ready.sh <repo>
# Exit: 0 limpo · 1 vazamento · 2 instrumento indisponível (nunca lido como limpo).
# Lista literal de termos internos: PUBLIC_GATE_EXTRA_CONFIG=<arquivo toml fora do repositório>.
#
# Quatro verificações (o scanner sozinho deixa lacunas: metadados de autor, mensagens e nomes de ref):
#   1 segredo, termo interno e e-mail corporativo no diff de todo commit, merges incluídos (gitleaks)
#   2 autor, committer e tagger (e-mail e nome)
#   3 mensagens de commit e de tag, nomes de branch e de tag e nomes de arquivo: todo padrão vale para todo metadado
#   4 caminhos proibidos, CPF e e-mail pessoal em todo o histórico, credencial na URL de remoto
#
# Limites declarados: o gitleaks não lê objetos fora do git (submódulo, Git LFS: reprovam), e o portão recusa (exit 2)
# repositório raso, clone parcial e grafts. Objetos de substituição são ignorados: lê-se sempre o histórico real.
# Binário e atributo -diff são lidos como texto (--text) e passam ao gitleaks por stdin, pois ele não os lê em modo git.
set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CONFIG_PADRAO="$AQUI/../../.gitleaks.toml"
CAMINHOS_PADRAO="$AQUI/caminhos-proibidos.txt"

# Variáveis do git herdadas (hook, outro repo) redirecionariam toda leitura: o alvo é só o caminho passado.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_NAMESPACE
unset GIT_CONFIG_PARAMETERS GIT_CONFIG GIT_EXTERNAL_DIFF GIT_DIFF_OPTS GIT_ATTR_SOURCE

# Configuração ambiente não pode mudar o que o portão lê. Global e de sistema são anuladas; a local do repo
# (que quem prepara o repo controla) é sobreposta por variáveis de linha de comando, que valem também para
# o git que o gitleaks chama por conta própria. Toda leitura do git passa por g().
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_PAGER=cat PAGER=cat GIT_TERMINAL_PROMPT=0
GIT_CONFIG_COUNT=0
forcar() { # chave valor
  export "GIT_CONFIG_KEY_$GIT_CONFIG_COUNT=$1" "GIT_CONFIG_VALUE_$GIT_CONFIG_COUNT=$2"
  GIT_CONFIG_COUNT=$((GIT_CONFIG_COUNT+1))
}
forcar color.ui never               # ANSI antes do "+" faria o filtro de linhas adicionadas descartar tudo
forcar color.diff never
forcar diff.wsErrorHighlight none
forcar diff.colorMoved no
forcar diff.noprefix false          # prefixos de caminho e de lado do diff: formato fixo
forcar diff.mnemonicPrefix false
forcar diff.srcPrefix a/
forcar diff.dstPrefix b/
forcar diff.renames false           # arquivo renomeado aparece inteiro como adicionado
forcar core.quotePath false         # nomes com acento ou espaço sem escape octal
forcar log.showSignature false      # saída de verificação de assinatura misturada ao texto
forcar log.decorate no
forcar log.showRoot true            # sem isso o commit raiz some de todo diff (e da contagem de controle)
forcar log.mailmap false            # autor e committer como gravados, nunca reescritos por .mailmap
forcar i18n.logOutputEncoding UTF-8
forcar core.pager cat
forcar core.fsmonitor false         # a config local não executa programa nenhum durante a leitura
export GIT_CONFIG_COUNT
g() { git -C "$REPO" "$@"; }

indisponivel() { echo "INSTRUMENTO INDISPONIVEL: $1" >&2; exit 2; }

REPO="${1:-}"
[ -n "$REPO" ] || indisponivel "uso: check-public-ready.sh <repo>"
g rev-parse --git-dir >/dev/null 2>&1 || indisponivel "não é um repositório git: $REPO"
REPO="$(g rev-parse --show-toplevel 2>/dev/null)" && [ -n "$REPO" ] || indisponivel "sem árvore de trabalho (repositório nu?)"
command -v gitleaks >/dev/null 2>&1 || indisponivel "gitleaks não instalado"
command -v perl >/dev/null 2>&1 || indisponivel "perl não instalado"
g rev-parse --verify HEAD >/dev/null 2>&1 || indisponivel "repositório sem commits: $REPO"
[ "$(g config --get color.ui 2>/dev/null)" = never ] \
  || indisponivel "git não aplicou a configuração forçada (GIT_CONFIG_COUNT exige git 2.31 ou mais novo)"

# O portão só aprova o que consegue ler por inteiro: histórico incompleto ou reescrito em leitura nunca é "limpo".
[ "$(g rev-parse --is-shallow-repository 2>/dev/null)" = false ] \
  || indisponivel "repositório raso: commits omitidos não foram examinados"
export GIT_NO_LAZY_FETCH=1
if g config --get extensions.partialclone >/dev/null 2>&1 \
   || g config --get-regexp '^remote\..*\.promisor$' 2>/dev/null | grep -q true \
   || g rev-list --all --objects --missing=print 2>/dev/null | grep -q '^?'; then
  indisponivel "clone parcial ou objetos ausentes: bytes do histórico não estão disponíveis"
fi
GRAFTS="$(g rev-parse --path-format=absolute --git-path info/grafts 2>/dev/null)" \
  && [ -n "$GRAFTS" ] || indisponivel "não resolveu o caminho de info/grafts"
[ ! -e "$GRAFTS" ] || indisponivel "grafts presentes: histórico lido seria outro"
# Objetos de substituição (git replace) escondem o que será publicado: toda leitura usa os objetos reais.
export GIT_NO_REPLACE_OBJECTS=1

CONFIG="$REPO/.gitleaks.toml"
[ -s "$CONFIG" ] || CONFIG="$CONFIG_PADRAO"
[ -s "$CONFIG" ] || indisponivel "sem .gitleaks.toml"

EXTRA="${PUBLIC_GATE_EXTRA_CONFIG:-}"
if [ -n "$EXTRA" ] && [ ! -r "$EXTRA" ]; then
  indisponivel "PUBLIC_GATE_EXTRA_CONFIG aponta para arquivo ilegível"
fi
[ -z "$EXTRA" ] || EXTRA="$(cd "$(dirname "$EXTRA")" && pwd -P)/$(basename "$EXTRA")"

TMP="$(mktemp -d)" || indisponivel "sem diretório temporário"
trap 'rm -rf "$TMP"' EXIT
mkdir "$TMP/neutro" || indisponivel "sem diretório neutro"
# O gitleaks lê .gitleaksignore do diretório de execução (padrão "."): roda sempre de um diretório vazio, com caminhos absolutos.
gl() { ( cd "$TMP/neutro" && gitleaks "$@" ); }
VAZOU=0

# A configuração que o portão usa pode vir do próprio alvo, e quem a edita controla o que o scanner enxerga. Duas defesas:
# (1) palavra que cala ou desliga detector (allowlist em qualquer nível, disabledRules) reprova;
# (2) controle positivo: com a configuração em uso, o gitleaks tem de achar um token de prova montado aqui, em tempo de
# execução. Config sem os detectores padrão, ou que cala por outra via, é leitura cega: exit 2, nunca limpo.
CONFIG_CALA=0
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  if grep -Eiq 'allowlist|disabledRules' "$cfg"; then CONFIG_CALA=1; fi
done
if [ "$CONFIG_CALA" -eq 0 ]; then
  printf 'token=%s%s\n' "gh""p_" "aB3dE5gH7jK9mN1pQ3sT5vX7zC9eF1hJ3kL5" > "$TMP/controle-positivo.txt"
  gl stdin --config "$CONFIG" --ignore-gitleaks-allow --redact --no-banner --no-color --exit-code 1 \
    < "$TMP/controle-positivo.txt" >/dev/null 2>&1
  [ $? -eq 1 ] || indisponivel "controle positivo: o gitleaks não achou o token de prova com a configuração em uso"
fi

# --- regras de texto (id<TAB>regex), lidas das regras [[rules]] dos .toml
extrair_regras() { # arquivo...
  perl -ne '
    if (/^\s*id\s*=\s*"([^"]+)"/) { $id = $1 }
    if (/^\s*regex\s*=\s*\x27\x27\x27(.*)\x27\x27\x27\s*$/) { print "$id\t$1\n" }
  ' "$@"
}
if [ -n "$EXTRA" ]; then extrair_regras "$CONFIG" "$EXTRA" > "$TMP/regras.tsv"; else extrair_regras "$CONFIG" > "$TMP/regras.tsv"; fi
[ -s "$TMP/regras.tsv" ] || indisponivel "nenhuma regra de texto lida da configuração"

# Lê stdin; imprime o id de cada regra que casa (sem o texto). Exit 1 se alguma casou.
casar_regras() { # arquivo-de-regras
  perl -e '
    open(my $f, "<", $ARGV[0]) or exit 2; my @r;
    while (<$f>) { chomp; my ($id,$re)=split(/\t/,$_,2); push @r, [$id, qr/$re/]; }
    my %visto; my $achou = 0;
    while (my $l = <STDIN>) { for my $x (@r) { if ($l =~ $x->[1] and !$visto{$x->[0]}++) { print "$x->[0]\n"; $achou = 1 } } }
    exit($achou ? 1 : 0);
  ' "$1"
}

# Domínios de fornecedor aceitos como noreply@ só em TEXTO (linhas de coautoria de commit); nunca como identidade.
NOREPLY_TEXTO='anthropic\.com|openai\.com|google\.com|github\.com'
PERMITIDOS='(@users\.noreply\.github\.com$|^noreply@('"$NOREPLY_TEXTO"')$|@([a-z0-9-]+\.)*example\.(com|org|net|test)$|@([a-z0-9-]+\.)+(example|test|invalid|localhost)$)'
# Identidade (autor, committer, tagger): só o noreply do GitHub.
IDENTIDADE_OK='(@users\.noreply\.github\.com|^noreply@github\.com)$'
CPF_RE='[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}'

# CPF e e-mail fora da lista permitida em um texto; imprime o rótulo de cada achado. Exit 1 se houve.
checar_cpf_email() { # arquivo rotulo
  local achou=0
  if grep -aEq "$CPF_RE" "$1"; then echo "verificacao $VERIF: VAZAMENTO cpf-$2"; achou=1; fi
  grep -aoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$1" > "$TMP/emails-achados.txt"
  [ $? -le 1 ] || indisponivel "grep de e-mails falhou"
  if grep -Evi "$PERMITIDOS" "$TMP/emails-achados.txt" | grep -q .; then
    echo "verificacao $VERIF: VAZAMENTO email-fora-da-lista-permitida-$2"; achou=1
  fi
  return $achou
}

# Linhas adicionadas em qualquer commit alcançável, merges incluídos (-m: diff contra cada pai, pega o que nasce só na resolução).
# --text: binário, atributo -diff e arquivo acima de core.bigFileThreshold também entregam os bytes; sem textconv nem driver externo.
g log --all --root -m --text --no-color --no-renames --no-ext-diff --no-textconv -p --format= 2>/dev/null | grep -a '^+' > "$TMP/adicionadas.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || indisponivel "git log -p falhou"
# Controle do extrator: o git diz quantas linhas foram adicionadas; extrair menos que isso é filtro cego, nunca "limpo".
ESPERADAS=$(g log --all --root -m --text --no-color --no-renames --numstat --format= 2>/dev/null | awk '$1 ~ /^[0-9]+$/ { s += $1 } END { print s + 0 }')
EXTRAIDAS=$(wc -l < "$TMP/adicionadas.txt" | tr -d ' ')
# Fonte independente de opção de diff: toda linha de todo arquivo de um commit raiz é adição (git grep não depende de log.*).
RAIZES=$(g rev-list --all --max-parents=0) || indisponivel "git rev-list falhou"
LINHAS_RAIZ=0
for raiz in $RAIZES; do
  n=$(g grep -a -c '' "$raiz" -- 2>/dev/null | awk -F: '{ s += $NF } END { print s + 0 }')
  LINHAS_RAIZ=$((LINHAS_RAIZ + n))
done
[ "$EXTRAIDAS" -ge "$LINHAS_RAIZ" ] || indisponivel "extração não contém as linhas do commit raiz ($EXTRAIDAS de $LINHAS_RAIZ)"
[ "$EXTRAIDAS" -ge "$ESPERADAS" ] || indisponivel "extração de linhas adicionadas incompleta ($EXTRAIDAS de $ESPERADAS)"

# Nomes de todo caminho tocado em qualquer ref (histórico inteiro, não só HEAD), delimitados por NUL: o git escapa
# TAB, aspas, barra invertida e quebra de linha em saída com quebra de linha, mesmo com core.quotePath=false.
g log --all --root -m --name-only -z --format= > "$TMP/nomes.nul" || indisponivel "git log falhou"
g ls-files -z >> "$TMP/nomes.nul" || indisponivel "git ls-files falhou"
perl -0ne 'chomp; next if $_ eq ""; if (/\n/) { $nl = 1; next } print "$_\n"; END { exit($nl ? 3 : 0) }' \
  < "$TMP/nomes.nul" | sort -u > "$TMP/arquivos.txt"
RC_PERL=${PIPESTATUS[0]}
NOME_COM_QUEBRA=0
case $RC_PERL in 0) ;; 3) NOME_COM_QUEBRA=1 ;; *) indisponivel "perl falhou ao ler nomes" ;; esac
NARQ=$(g ls-files -z | tr -cd '\0' | wc -c | tr -d ' ')
[ "$NOME_COM_QUEBRA" -eq 1 ] || [ "$(wc -l < "$TMP/arquivos.txt" | tr -d ' ')" -ge "$NARQ" ] || indisponivel "extração de nomes de arquivo incompleta"

# --- Verificação 1
v1_ok=1
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  gl git "$REPO" --config "$cfg" --log-opts="--all -m" --ignore-gitleaks-allow --redact --no-banner \
    --no-color --exit-code 1 >/dev/null 2>&1
  rc=$?
  case $rc in
    0) ;;
    1) v1_ok=0 ;;
    *) indisponivel "gitleaks saiu com $rc (config: $(basename "$cfg"))" ;;
  esac
done
# O gitleaks git não lê conteúdo binário nem arquivo com -diff; o mesmo texto bruto passa por ele via stdin.
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  gl stdin --config "$cfg" --ignore-gitleaks-allow --redact --no-banner --no-color --exit-code 1 \
    < "$TMP/adicionadas.txt" >/dev/null 2>&1
  rc=$?
  case $rc in
    0) ;;
    1) v1_ok=0 ;;
    *) indisponivel "gitleaks stdin saiu com $rc (config: $(basename "$cfg"))" ;;
  esac
done
if [ $v1_ok -eq 1 ]; then echo "verificacao 1: limpo"
else echo "verificacao 1: VAZAMENTO segredo-ou-termo-no-diff-de-algum-commit (detalhe: gitleaks com --redact)"; VAZOU=1; fi

# --- Verificação 2: autoria
g log --all --format='%ae%n%ce' > "$TMP/emails.txt" || indisponivel "git log falhou"
g log --all --format='%an%n%cn' > "$TMP/nomes.txt" || indisponivel "git log falhou"
g for-each-ref refs/tags --format='%(taggeremail)' | tr -d '<>' | grep -v '^$' >> "$TMP/emails.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || indisponivel "for-each-ref falhou"
g for-each-ref refs/tags --format='%(taggername)' | grep -v '^$' >> "$TMP/nomes.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || indisponivel "for-each-ref falhou"
v2_ok=1
if grep -Evi "$IDENTIDADE_OK" "$TMP/emails.txt" | grep -q .; then
  echo "verificacao 2: VAZAMENTO autor-ou-committer-com-email-fora-do-noreply"; v2_ok=0
fi
cat "$TMP/emails.txt" "$TMP/nomes.txt" | casar_regras "$TMP/regras.tsv" > "$TMP/hit.txt"
if [ $? -eq 1 ]; then echo "verificacao 2: VAZAMENTO autor-casa-regra: $(paste -sd, "$TMP/hit.txt")"; v2_ok=0; fi
[ $v2_ok -eq 1 ] && echo "verificacao 2: limpo" || VAZOU=1

# --- Verificação 3: metadados — mensagens, conteúdo de tags, nomes de ref, autor/committer/tagger e nomes de arquivo.
# Todo padrão (regras de texto, detectores padrão do gitleaks, CPF, e-mail fora da lista) vale para todo esse texto.
{
  g log --all --format=%B
  g for-each-ref --format='%(refname)'
  g for-each-ref refs/tags --format='%(contents)'
  g for-each-ref refs/tags --format='%(taggername) %(taggeremail)'
  g log --all --format='%an %ae%n%cn %ce'
  cat "$TMP/arquivos.txt"
} > "$TMP/textos.txt" 2>/dev/null || indisponivel "git log/for-each-ref falhou"
# Controle dos extratores de metadado: cada commit rende ao menos uma linha de mensagem; contagem menor que isso é leitura cega.
NCOMMITS=$(g rev-list --all --count 2>/dev/null) || indisponivel "git rev-list falhou"
[ "$(wc -l < "$TMP/textos.txt" | tr -d ' ')" -ge "$NCOMMITS" ] || indisponivel "extração de metadados incompleta"
casar_regras "$TMP/regras.tsv" < "$TMP/textos.txt" > "$TMP/hit.txt"
rc=$?
v3_ok=1
VERIF=3
if [ $rc -eq 1 ]; then
  echo "verificacao 3: VAZAMENTO metadado-casa-regra: $(paste -sd, "$TMP/hit.txt")"; v3_ok=0
fi
checar_cpf_email "$TMP/textos.txt" "em-metadado" || v3_ok=0
# O gitleaks varre diffs; os detectores padrão não veem metadado. O mesmo texto passa por ele via stdin.
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  gl stdin --config "$cfg" --ignore-gitleaks-allow --redact --no-banner --no-color --exit-code 1 \
    < "$TMP/textos.txt" >/dev/null 2>&1
  rc=$?
  case $rc in
    0) ;;
    1) echo "verificacao 3: VAZAMENTO segredo-em-metadado (gitleaks, config: $(basename "$cfg"))"; v3_ok=0 ;;
    *) indisponivel "gitleaks stdin saiu com $rc (config: $(basename "$cfg"))" ;;
  esac
done
[ $v3_ok -eq 1 ] && echo "verificacao 3: limpo" || VAZOU=1

# --- Verificação 4: caminhos, CPF, e-mails na árvore, credencial em URL de remoto
v4_ok=1
[ -r "$CAMINHOS_PADRAO" ] || CAMINHOS_PADRAO="$REPO/scripts/gate/caminhos-proibidos.txt"
[ -r "$CAMINHOS_PADRAO" ] || indisponivel "sem caminhos-proibidos.txt"
grep -Ev '^\s*(#|$)' "$CAMINHOS_PADRAO" > "$TMP/caminhos.txt"
if [ -n "$EXTRA" ]; then
  perl -ne 'if (/^\s*caminhos\s*=\s*\[/) { $d=1; next } if ($d && /^\s*\]/) { $d=0 } if ($d && /\x27([^\x27]+)\x27/) { print "$1\n" }' "$EXTRA" >> "$TMP/caminhos.txt"
fi
while IFS= read -r padrao; do
  if grep -Eq -e "$padrao" "$TMP/arquivos.txt"; then echo "verificacao 4: VAZAMENTO caminho-proibido-versionado"; v4_ok=0; break; fi
done < "$TMP/caminhos.txt"

# Conteúdo que não está no git: submódulo (gitlink) e Git LFS (ponteiro) deixam bytes fora do alcance do portão.
g log --all --root -m --raw --no-abbrev --no-renames --format= > "$TMP/raw.txt" || indisponivel "git log --raw falhou"
if grep -Eq '^:(160000 [0-7]{6}|[0-7]{6} 160000) ' "$TMP/raw.txt"; then
  echo "verificacao 4: VAZAMENTO submodulo-no-historico (conteudo fora do git, nao examinado)"; v4_ok=0
fi
if grep -aEq 'filter[=]lfs|git-lfs[.]github[.]com/spec' "$TMP/adicionadas.txt"; then
  echo "verificacao 4: VAZAMENTO git-lfs-no-historico (conteudo fora do git, nao examinado)"; v4_ok=0
fi
# Arquivos que calam o próprio gitleaks (ignore, baseline, configuração alternativa) em qualquer revisão ou na árvore.
if grep -Eq '(^|/)\.gitleaksignore$' "$TMP/arquivos.txt" || [ -e "$REPO/.gitleaksignore" ]; then
  echo "verificacao 4: VAZAMENTO gitleaksignore-presente"; v4_ok=0
fi
if grep -Eiq 'gitleaks[^/]*baseline|baseline[^/]*gitleaks' "$TMP/arquivos.txt"; then
  echo "verificacao 4: VAZAMENTO baseline-do-gitleaks-versionado"; v4_ok=0
fi
if grep -Ei '(^|/)\.?gitleaks[^/]*\.toml$' "$TMP/arquivos.txt" | grep -Evx '\.gitleaks\.toml' | grep -q .; then
  echo "verificacao 4: VAZAMENTO config-alternativa-do-gitleaks-versionada"; v4_ok=0
fi
if [ "$CONFIG_CALA" -eq 1 ]; then
  echo "verificacao 4: VAZAMENTO config-do-gitleaks-cala-ou-desliga-detector"; v4_ok=0
fi
# Ref cujo objeto final não é commit (tag para blob ou árvore, também por tag anotada): `git log --all` não a percorre,
# mas `git push --tags` publica o objeto. Todo ref tem de apontar, no fim da cadeia, para um commit.
g for-each-ref --format='%(refname)' > "$TMP/refs.txt" || indisponivel "git for-each-ref falhou"
REF_NAO_COMMIT=0
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  tipo=$(g cat-file -t "$ref^{}" 2>/dev/null) || indisponivel "não resolveu o objeto final do ref"
  [ "$tipo" = commit ] || REF_NAO_COMMIT=1
done < "$TMP/refs.txt"
if [ "$REF_NAO_COMMIT" -eq 1 ]; then
  echo "verificacao 4: VAZAMENTO ref-aponta-para-objeto-que-nao-e-commit (conteudo publicado e nao examinado)"; v4_ok=0
fi
VERIF=4
checar_cpf_email "$TMP/adicionadas.txt" "no-historico" || v4_ok=0
if [ "$NOME_COM_QUEBRA" -eq 1 ]; then
  echo "verificacao 4: VAZAMENTO nome-de-arquivo-com-quebra-de-linha"; v4_ok=0
fi
# Credencial em qualquer chave da configuração local (url, pushurl, insteadOf, proxy, submódulo...), cabeçalho e helper em arquivo.
g config --list > "$TMP/config-local.txt" 2>/dev/null || indisponivel "git config --list falhou"
if grep -Ei '://[^/@[:space:]]+@' "$TMP/config-local.txt" | grep -Evi '://git@' | grep -q .; then
  echo "verificacao 4: VAZAMENTO credencial-na-configuracao-local"; v4_ok=0
fi
if grep -Eiq '^http\..*extraheader=.*(authorization|bearer|basic|token)' "$TMP/config-local.txt"; then
  echo "verificacao 4: VAZAMENTO cabecalho-de-autorizacao-na-configuracao-local"; v4_ok=0
fi
if grep -Eiq '^credential\..*helper=.*store' "$TMP/config-local.txt"; then
  echo "verificacao 4: VAZAMENTO helper-de-credencial-em-arquivo"; v4_ok=0
fi
[ $v4_ok -eq 1 ] && echo "verificacao 4: limpo" || VAZOU=1

[ $VAZOU -eq 0 ] && exit 0
exit 1
