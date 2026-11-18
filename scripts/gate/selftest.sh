#!/usr/bin/env bash
# Autoteste do portão: controle positivo e negativo por classe de vazamento.
# Todo valor suspeito é montado por concatenação em tempo de execução: este arquivo
# nunca contém o padrão que o portão procura.
# Exit 0 só se toda classe se comportou como esperado.
set -u

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
GATE="$AQUI/check-public-ready.sh"
RAIZ_TMP="$(mktemp -d)"
trap 'rm -rf "$RAIZ_TMP"' EXIT

FALHAS=0
EMAIL_LIMPO="1+teste@users.noreply.github.com"

novo_repo() {
  local d="$RAIZ_TMP/$1"
  mkdir -p "$d"
  git -C "$d" init -q -b main
  git -C "$d" config user.email "$EMAIL_LIMPO"
  git -C "$d" config user.name "teste"
  git -C "$d" config commit.gpgsign false
  echo "$d"
}

commitar() { # repo mensagem
  git -C "$1" add -A
  git -C "$1" commit -q --allow-empty -m "$2"
}

base_limpa() {
  echo "# projeto de teste" > "$1/README.md"
  commitar "$1" "chore: base limpa"
}

esperar() { # classe esperado(limpo|vaza) repo
  local rc
  PUBLIC_GATE_EXTRA_CONFIG="${EXTRA_SELFTEST:-}" bash "$GATE" "$3" >/dev/null 2>&1
  rc=$?
  if [ "$2" = limpo ]; then
    if [ $rc -eq 0 ]; then echo "PASSOU $1"; else echo "FALHOU $1 (esperava 0, veio $rc)"; FALHAS=$((FALHAS+1)); fi
  else
    if [ $rc -eq 1 ]; then echo "PASSOU $1"; else echo "FALHOU $1 (esperava 1, veio $rc)"; FALHAS=$((FALHAS+1)); fi
  fi
}

# --- controle negativo: repositório limpo aprova
R=$(novo_repo limpo); base_limpa "$R"
esperar "limpo" limpo "$R"

# --- segredo que entra num commit e sai no seguinte (continua no histórico)
R=$(novo_repo segredo-apagado); base_limpa "$R"
SEG="gh""p_""aB3dE5gH7jK9mN1pQ3sT5vX7zC9eF1hJ3kL5"
echo "token=$SEG" > "$R/config.txt"; commitar "$R" "feat: adiciona config"
git -C "$R" rm -q config.txt; commitar "$R" "fix: remove config"
esperar "segredo-apagado-depois" vaza "$R"

[ $FALHAS -eq 0 ] || { echo "autoteste: $FALHAS falha(s)" >&2; exit 1; }
exit 0
