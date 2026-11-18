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

indisponivel() { echo "INSTRUMENTO INDISPONIVEL: $1" >&2; exit 2; }

REPO="${1:-}"
[ -n "$REPO" ] || indisponivel "uso: check-public-ready.sh <repo>"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || indisponivel "não é um repositório git: $REPO"
REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
command -v gitleaks >/dev/null 2>&1 || indisponivel "gitleaks não instalado"
command -v perl >/dev/null 2>&1 || indisponivel "perl não instalado"
git -C "$REPO" rev-parse --verify HEAD >/dev/null 2>&1 || indisponivel "repositório sem commits: $REPO"

# O portão só aprova o que consegue ler por inteiro: histórico incompleto ou reescrito em leitura nunca é "limpo".
[ "$(git -C "$REPO" rev-parse --is-shallow-repository 2>/dev/null)" = false ] \
  || indisponivel "repositório raso: commits omitidos não foram examinados"
export GIT_NO_LAZY_FETCH=1
if git -C "$REPO" config --get extensions.partialclone >/dev/null 2>&1 \
   || git -C "$REPO" config --get-regexp '^remote\..*\.promisor$' 2>/dev/null | grep -q true \
   || git -C "$REPO" rev-list --all --objects --missing=print 2>/dev/null | grep -q '^?'; then
  indisponivel "clone parcial ou objetos ausentes: bytes do histórico não estão disponíveis"
fi
[ ! -e "$(git -C "$REPO" rev-parse --git-path info/grafts)" ] || indisponivel "grafts presentes: histórico lido seria outro"
# Objetos de substituição (git replace) escondem o que será publicado: toda leitura usa os objetos reais.
export GIT_NO_REPLACE_OBJECTS=1

CONFIG="$REPO/.gitleaks.toml"
[ -s "$CONFIG" ] || CONFIG="$CONFIG_PADRAO"
[ -s "$CONFIG" ] || indisponivel "sem .gitleaks.toml"

EXTRA="${PUBLIC_GATE_EXTRA_CONFIG:-}"
if [ -n "$EXTRA" ] && [ ! -r "$EXTRA" ]; then
  indisponivel "PUBLIC_GATE_EXTRA_CONFIG aponta para arquivo ilegível"
fi

TMP="$(mktemp -d)" || indisponivel "sem diretório temporário"
trap 'rm -rf "$TMP"' EXIT
VAZOU=0

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
git -C "$REPO" log --all -m --text --no-ext-diff --no-textconv -p --format= 2>/dev/null | grep -a '^+' > "$TMP/adicionadas.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || indisponivel "git log -p falhou"

# --- Verificação 1
v1_ok=1
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  gitleaks git "$REPO" --config "$cfg" --log-opts="--all -m" --ignore-gitleaks-allow --redact --no-banner \
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
  gitleaks stdin --config "$cfg" --ignore-gitleaks-allow --redact --no-banner --no-color --exit-code 1 \
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
git -C "$REPO" log --all --format='%ae%n%ce' > "$TMP/emails.txt" || indisponivel "git log falhou"
git -C "$REPO" log --all --format='%an%n%cn' > "$TMP/nomes.txt" || indisponivel "git log falhou"
git -C "$REPO" for-each-ref refs/tags --format='%(taggeremail)' | tr -d '<>' | grep -v '^$' >> "$TMP/emails.txt"
[ "${PIPESTATUS[0]}" -eq 0 ] || indisponivel "for-each-ref falhou"
git -C "$REPO" for-each-ref refs/tags --format='%(taggername)' | grep -v '^$' >> "$TMP/nomes.txt"
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
  git -C "$REPO" log --all --format=%B
  git -C "$REPO" for-each-ref --format='%(refname)'
  git -C "$REPO" for-each-ref refs/tags --format='%(contents)'
  git -C "$REPO" for-each-ref refs/tags --format='%(taggername) %(taggeremail)'
  git -C "$REPO" log --all --format='%an %ae%n%cn %ce'
  git -C "$REPO" -c core.quotepath=false log --all -m --name-only --format=
  git -C "$REPO" ls-files
} > "$TMP/textos.txt" 2>/dev/null || indisponivel "git log/for-each-ref falhou"
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
  gitleaks stdin --config "$cfg" --ignore-gitleaks-allow --redact --no-banner --no-color --exit-code 1 \
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
# Histórico inteiro, não só HEAD: o que entrou e saiu continua público. Nomes de todo caminho tocado em qualquer ref.
git -C "$REPO" -c core.quotepath=false log --all -m --name-only --format= > "$TMP/arquivos-bruto.txt" || indisponivel "git log falhou"
git -C "$REPO" ls-files >> "$TMP/arquivos-bruto.txt" || indisponivel "git ls-files falhou"
sort -u "$TMP/arquivos-bruto.txt" > "$TMP/arquivos.txt"
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
git -C "$REPO" log --all -m --raw --no-abbrev --no-renames --format= > "$TMP/raw.txt" || indisponivel "git log --raw falhou"
if grep -Eq '^:(160000 [0-7]{6}|[0-7]{6} 160000) ' "$TMP/raw.txt"; then
  echo "verificacao 4: VAZAMENTO submodulo-no-historico (conteudo fora do git, nao examinado)"; v4_ok=0
fi
if grep -aEq 'filter[=]lfs|git-lfs[.]github[.]com/spec' "$TMP/adicionadas.txt"; then
  echo "verificacao 4: VAZAMENTO git-lfs-no-historico (conteudo fora do git, nao examinado)"; v4_ok=0
fi
VERIF=4
checar_cpf_email "$TMP/adicionadas.txt" "no-historico" || v4_ok=0
git -C "$REPO" config --get-regexp '^remote\..*\.url$' > "$TMP/remotos.txt" 2>/dev/null || true
if grep -Eq '://[^/@[:space:]]+@' "$TMP/remotos.txt"; then
  echo "verificacao 4: VAZAMENTO credencial-na-url-do-remoto"; v4_ok=0
fi
[ $v4_ok -eq 1 ] && echo "verificacao 4: limpo" || VAZOU=1

[ $VAZOU -eq 0 ] && exit 0
exit 1
