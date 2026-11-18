#!/usr/bin/env bash
# Portão de publicação: prova que um repositório pode ir a público.
# Uso: check-public-ready.sh <repo>
# Exit: 0 limpo · 1 vazamento · 2 instrumento indisponível (nunca lido como limpo).
# Lista literal de termos internos: PUBLIC_GATE_EXTRA_CONFIG=<arquivo toml fora do repositório>.
set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
CONFIG_PADRAO="$AQUI/../../.gitleaks.toml"

indisponivel() { echo "INSTRUMENTO INDISPONIVEL: $1" >&2; exit 2; }

REPO="${1:-}"
[ -n "$REPO" ] || indisponivel "uso: check-public-ready.sh <repo>"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || indisponivel "não é um repositório git: $REPO"
REPO="$(git -C "$REPO" rev-parse --show-toplevel)"
command -v gitleaks >/dev/null 2>&1 || indisponivel "gitleaks não instalado"
git -C "$REPO" rev-parse --verify HEAD >/dev/null 2>&1 || indisponivel "repositório sem commits: $REPO"

CONFIG="$REPO/.gitleaks.toml"
[ -s "$CONFIG" ] || CONFIG="$CONFIG_PADRAO"
[ -s "$CONFIG" ] || indisponivel "sem .gitleaks.toml"

EXTRA="${PUBLIC_GATE_EXTRA_CONFIG:-}"
if [ -n "$EXTRA" ] && [ ! -r "$EXTRA" ]; then
  indisponivel "PUBLIC_GATE_EXTRA_CONFIG aponta para arquivo ilegível"
fi

VAZOU=0

# Verificação 1 — segredo, termo interno e e-mail corporativo no diff de TODO commit.
rodar_gitleaks() {
  local cfg="$1" rc
  gitleaks git "$REPO" --config "$cfg" --log-opts=--all --redact --no-banner \
    --no-color --exit-code 1 >/dev/null 2>&1
  rc=$?
  return $rc
}
v1_ok=1
for cfg in "$CONFIG" ${EXTRA:+"$EXTRA"}; do
  rodar_gitleaks "$cfg"
  rc=$?
  case $rc in
    0) ;;
    1) v1_ok=0 ;;
    *) indisponivel "gitleaks saiu com $rc (config: $(basename "$cfg"))" ;;
  esac
done
if [ $v1_ok -eq 1 ]; then
  echo "verificacao 1: limpo"
else
  echo "verificacao 1: VAZAMENTO segredo-ou-termo-no-historico (rode gitleaks com --redact para o detalhe)"
  VAZOU=1
fi

[ $VAZOU -eq 0 ] && exit 0
exit 1
