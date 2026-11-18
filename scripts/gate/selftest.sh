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

# Lista extra de teste: um termo fictício, para provar o caminho do arquivo extra (fora do repositório).
EXTRA_SELFTEST="$RAIZ_TMP/extra-teste.toml"
cat > "$EXTRA_SELFTEST" <<'TOML'
[[rules]]
id = "termo-fficticio"
regex = '''(?i)xyzzy[f]oo'''
TOML

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

# --- termo interno num arquivo
R=$(novo_repo termo-arquivo); base_limpa "$R"
echo "feito por a empresa ""ide""ia""business" > "$R/notas.md"; commitar "$R" "docs: notas"
esperar "termo-interno-no-arquivo" vaza "$R"

# --- e-mail corporativo no conteúdo
R=$(novo_repo email-corp); base_limpa "$R"
echo "contato: dev""@ide""iabusiness.com.br" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "email-corporativo-no-conteudo" vaza "$R"

# --- autor corporativo (só nos metadados do commit)
R=$(novo_repo autor-corp); base_limpa "$R"
echo "x" > "$R/a.txt"; git -C "$R" add -A
git -C "$R" -c user.email="fulano""@redeide""ia.com.br" commit -q -m "feat: a"
esperar "autor-corporativo" vaza "$R"

# --- termo em mensagem de commit (termo só da lista extra)
R=$(novo_repo termo-mensagem); base_limpa "$R"
commitar "$R" "feat: integra com xyzzy""foo"
esperar "termo-em-mensagem-de-commit" vaza "$R"

# --- termo em nome de branch
R=$(novo_repo termo-branch); base_limpa "$R"
git -C "$R" branch "feat/ide""iaos-x"
esperar "termo-em-nome-de-branch" vaza "$R"

# --- caminho proibido versionado
R=$(novo_repo caminho); base_limpa "$R"
mkdir -p "$R/.claude"; echo "x" > "$R/.claude/regra.md"; commitar "$R" "chore: config"
esperar "caminho-proibido-versionado" vaza "$R"

# --- CPF
R=$(novo_repo cpf); base_limpa "$R"
echo "cpf 123.456.""789-09" > "$R/dados.md"; commitar "$R" "docs: dados"
esperar "cpf-na-arvore" vaza "$R"

# --- credencial na URL do remoto
R=$(novo_repo remoto); base_limpa "$R"
git -C "$R" remote add origin "https://usuario:senha""falsa@servidor.example.com/x.git"
esperar "credencial-na-url-do-remoto" vaza "$R"

# --- e-mail pessoal comum
R=$(novo_repo email-pessoal); base_limpa "$R"
echo "fale com fulano""@gm""ail.com" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "email-pessoal-na-arvore" vaza "$R"

# --- histórico: o vazamento entra num commit e sai no seguinte (continua no histórico)
SEG2="gh""p_""zY8xW6vU4tS2rQ0pO8nM6lK4jI2hG0fE8dC6"
PESSOAL="fulano""@gm""ail.com"

R=$(novo_repo token-em-mensagem); base_limpa "$R"
commitar "$R" "feat: usa token $SEG2"
esperar "token-em-mensagem-de-commit" vaza "$R"

R=$(novo_repo token-em-tag); base_limpa "$R"
git -C "$R" tag -a v1 -m "versao com token $SEG2"
esperar "token-em-mensagem-de-tag" vaza "$R"

R=$(novo_repo cpf-apagado); base_limpa "$R"
echo "cpf 123.456.""789-09" > "$R/dados.md"; commitar "$R" "docs: dados"
git -C "$R" rm -q dados.md; commitar "$R" "fix: remove dados"
esperar "cpf-apagado-depois" vaza "$R"

R=$(novo_repo email-pessoal-apagado); base_limpa "$R"
echo "fale com $PESSOAL" > "$R/contato.md"; commitar "$R" "docs: contato"
git -C "$R" rm -q contato.md; commitar "$R" "fix: remove contato"
esperar "email-pessoal-apagado-depois" vaza "$R"

R=$(novo_repo caminho-apagado); base_limpa "$R"
mkdir -p "$R/.claude"; echo "x" > "$R/.claude/regra.md"; commitar "$R" "chore: config"
git -C "$R" rm -q -r .claude; commitar "$R" "fix: remove config"
esperar "caminho-proibido-apagado-depois" vaza "$R"

[ $FALHAS -eq 0 ] || { echo "autoteste: $FALHAS falha(s)" >&2; exit 1; }
exit 0
