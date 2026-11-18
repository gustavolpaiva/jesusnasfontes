#!/usr/bin/env bash
# Portão de publicação: prova que um repositório pode ir a público.
# Uso: check-public-ready.sh <repo>
# Exit: 0 limpo · 1 vazamento · 2 instrumento indisponível (nunca lido como limpo).
# Lista literal de termos internos: PUBLIC_GATE_EXTRA_CONFIG=<arquivo toml fora do repositório>.
#
# Quatro verificações (o scanner sozinho deixa lacunas: metadados de autor, mensagens e nomes de ref):
#   1 segredo, termo interno e e-mail corporativo no diff de todo commit (gitleaks, --all)
#   2 autor e committer (e-mail e nome) de todo commit
#   3 mensagens de commit e de tag, nomes de branch e de tag
#   4 caminhos versionados proibidos, CPF, e-mail pessoal na árvore, credencial na URL de remoto
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

# --- Verificação 1
v1_ok=1
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  gitleaks git "$REPO" --config "$cfg" --log-opts=--all --redact --no-banner \
    --no-color --exit-code 1 >/dev/null 2>&1
  rc=$?
  case $rc in
    0) ;;
    1) v1_ok=0 ;;
    *) indisponivel "gitleaks saiu com $rc (config: $(basename "$cfg"))" ;;
  esac
done
if [ $v1_ok -eq 1 ]; then echo "verificacao 1: limpo"
else echo "verificacao 1: VAZAMENTO segredo-ou-termo-no-diff-de-algum-commit (detalhe: gitleaks com --redact)"; VAZOU=1; fi

# --- Verificação 2: autoria
git -C "$REPO" log --all --format='%ae%n%ce' > "$TMP/emails.txt" || indisponivel "git log falhou"
git -C "$REPO" log --all --format='%an%n%cn' > "$TMP/nomes.txt" || indisponivel "git log falhou"
v2_ok=1
if grep -Evi '(@users\.noreply\.github\.com|^noreply@[a-z0-9.-]+)$' "$TMP/emails.txt" | grep -q .; then
  echo "verificacao 2: VAZAMENTO autor-ou-committer-com-email-fora-do-noreply"; v2_ok=0
fi
cat "$TMP/emails.txt" "$TMP/nomes.txt" | casar_regras "$TMP/regras.tsv" > "$TMP/hit.txt"
if [ $? -eq 1 ]; then echo "verificacao 2: VAZAMENTO autor-casa-regra: $(paste -sd, "$TMP/hit.txt")"; v2_ok=0; fi
[ $v2_ok -eq 1 ] && echo "verificacao 2: limpo" || VAZOU=1

# --- Verificação 3: mensagens, tags e nomes de ref
{
  git -C "$REPO" log --all --format=%B
  git -C "$REPO" for-each-ref --format='%(refname)'
  git -C "$REPO" for-each-ref refs/tags --format='%(contents)'
} > "$TMP/textos.txt" 2>/dev/null || indisponivel "git log/for-each-ref falhou"
casar_regras "$TMP/regras.tsv" < "$TMP/textos.txt" > "$TMP/hit.txt"
if [ $? -eq 1 ]; then
  echo "verificacao 3: VAZAMENTO mensagem-ou-nome-de-ref-casa-regra: $(paste -sd, "$TMP/hit.txt")"; VAZOU=1
else echo "verificacao 3: limpo"; fi

# --- Verificação 4: caminhos, CPF, e-mails na árvore, credencial em URL de remoto
v4_ok=1
git -C "$REPO" ls-files > "$TMP/arquivos.txt" || indisponivel "git ls-files falhou"
[ -r "$CAMINHOS_PADRAO" ] || CAMINHOS_PADRAO="$REPO/scripts/gate/caminhos-proibidos.txt"
[ -r "$CAMINHOS_PADRAO" ] || indisponivel "sem caminhos-proibidos.txt"
grep -Ev '^\s*(#|$)' "$CAMINHOS_PADRAO" > "$TMP/caminhos.txt"
if [ -n "$EXTRA" ]; then
  perl -ne 'if (/^\s*caminhos\s*=\s*\[/) { $d=1; next } if ($d && /^\s*\]/) { $d=0 } if ($d && /\x27([^\x27]+)\x27/) { print "$1\n" }' "$EXTRA" >> "$TMP/caminhos.txt"
fi
while IFS= read -r padrao; do
  if grep -Eq -e "$padrao" "$TMP/arquivos.txt"; then echo "verificacao 4: VAZAMENTO caminho-proibido-versionado"; v4_ok=0; break; fi
done < "$TMP/caminhos.txt"

if git -C "$REPO" grep -I -qE '[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}' HEAD -- 2>/dev/null; then
  echo "verificacao 4: VAZAMENTO cpf-na-arvore"; v4_ok=0
fi
git -C "$REPO" grep -I -hoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' HEAD -- 2>/dev/null > "$TMP/emails-arvore.txt" || true
if sed -E 's/^[^:]*://' "$TMP/emails-arvore.txt" \
   | grep -Evi '(@users\.noreply\.github\.com|^noreply@.+|@([a-z0-9-]+\.)*example\.(com|org|net|test))$' | grep -q .; then
  echo "verificacao 4: VAZAMENTO email-fora-da-lista-permitida-na-arvore"; v4_ok=0
fi
git -C "$REPO" config --get-regexp '^remote\..*\.url$' > "$TMP/remotos.txt" 2>/dev/null || true
if grep -Eq '://[^/@[:space:]]+@' "$TMP/remotos.txt"; then
  echo "verificacao 4: VAZAMENTO credencial-na-url-do-remoto"; v4_ok=0
fi
[ $v4_ok -eq 1 ] && echo "verificacao 4: limpo" || VAZOU=1

[ $VAZOU -eq 0 ] && exit 0
exit 1
