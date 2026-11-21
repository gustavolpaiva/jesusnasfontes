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

caminhos = [
  '^pasta-proibida-á/',
]
TOML

esperar() { # classe esperado(limpo|vaza) repo
  local rc
  PUBLIC_GATE_EXTRA_CONFIG="${EXTRA_SELFTEST:-}" bash "$GATE" "$3" >/dev/null 2>&1
  rc=$?
  if [ "$2" = limpo ]; then
    if [ $rc -eq 0 ]; then echo "PASSOU $1"; else echo "FALHOU $1 (esperava 0, veio $rc)"; FALHAS=$((FALHAS+1)); fi
  elif [ "$2" = indeterminado ]; then
    if [ $rc -eq 2 ]; then echo "PASSOU $1"; else echo "FALHOU $1 (esperava 2, veio $rc)"; FALHAS=$((FALHAS+1)); fi
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

R=$(novo_repo email-tld-reservado); base_limpa "$R"
echo "contato: fulano""@host.exam""ple e outro""@api.te""st" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "email-tld-reservado-aprovado" limpo "$R"

R=$(novo_repo email-example-no-meio); base_limpa "$R"
echo "fale com fulano""@mail.exam""ple.empresa""real.com" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "email-example-no-meio-reprovado" vaza "$R"

# --- matriz padrões x superfícies: mensagens, tags, refs, metadados, nomes de arquivo, merges
CPF="123.456.""789-09"

R=$(novo_repo cpf-msg-commit); base_limpa "$R"
commitar "$R" "docs: dado do titular $CPF"
esperar "cpf-em-mensagem-de-commit" vaza "$R"

R=$(novo_repo email-msg-commit); base_limpa "$R"
commitar "$R" "docs: fale com $PESSOAL"
esperar "email-pessoal-em-mensagem-de-commit" vaza "$R"

R=$(novo_repo cpf-msg-tag); base_limpa "$R"
git -C "$R" tag -a v1 -m "versao do titular $CPF"
esperar "cpf-em-mensagem-de-tag" vaza "$R"

R=$(novo_repo email-msg-tag); base_limpa "$R"
git -C "$R" tag -a v1 -m "contato $PESSOAL"
esperar "email-pessoal-em-mensagem-de-tag" vaza "$R"

R=$(novo_repo cpf-ref); base_limpa "$R"
git -C "$R" branch "feat/titular-$CPF"
esperar "cpf-em-nome-de-branch" vaza "$R"

R=$(novo_repo tagger-email); base_limpa "$R"
git -C "$R" -c user.email="$PESSOAL" tag -a v1 -m "versao"
esperar "email-pessoal-no-tagger" vaza "$R"

R=$(novo_repo tagger-termo); base_limpa "$R"
git -C "$R" -c user.name="Fulano xyzzy""foo" tag -a v1 -m "versao"
esperar "termo-no-nome-do-tagger" vaza "$R"

R=$(novo_repo autor-cpf); base_limpa "$R"
echo "x" > "$R/a.txt"; git -C "$R" add -A
git -C "$R" -c user.name="Fulano $CPF" commit -q -m "feat: a"
esperar "cpf-no-nome-do-autor" vaza "$R"

R=$(novo_repo arquivo-cpf); base_limpa "$R"
echo "x" > "$R/titular-$CPF.txt"; commitar "$R" "docs: ficha"
git -C "$R" rm -q "titular-$CPF.txt"; commitar "$R" "fix: remove ficha"
esperar "cpf-no-nome-de-arquivo" vaza "$R"

R=$(novo_repo arquivo-termo); base_limpa "$R"
echo "x" > "$R/xyzzy""foo.md"; commitar "$R" "docs: notas"
esperar "termo-no-nome-de-arquivo" vaza "$R"

# merge: o vazamento nasce só na resolução, nunca em um dos pais
merge_com() { # repo conteudo-do-vazamento
  git -C "$1" checkout -q -b rama
  echo "a" > "$1/a.txt"; commitar "$1" "feat: a"
  git -C "$1" checkout -q main
  echo "b" > "$1/b.txt"; commitar "$1" "feat: b"
  git -C "$1" merge -q --no-commit --no-ff rama >/dev/null 2>&1
  echo "$2" > "$1/resolucao.txt"
  commitar "$1" "merge: integra rama"
}

R=$(novo_repo merge-segredo); base_limpa "$R"
merge_com "$R" "token=$SEG2"
esperar "segredo-so-na-resolucao-de-merge" vaza "$R"

R=$(novo_repo merge-cpf); base_limpa "$R"
merge_com "$R" "cpf $CPF"
esperar "cpf-so-na-resolucao-de-merge" vaza "$R"

R=$(novo_repo merge-email); base_limpa "$R"
merge_com "$R" "fale com $PESSOAL"
esperar "email-pessoal-so-na-resolucao-de-merge" vaza "$R"

R=$(novo_repo merge-limpo); base_limpa "$R"
merge_com "$R" "resolvido sem dado sensivel"
esperar "merge-limpo" limpo "$R"

# --- exceção noreply: identidade aceita só o noreply do GitHub; fornecedor vale só como coautor em texto
NR="no""reply"

R=$(novo_repo noreply-pessoal-conteudo); base_limpa "$R"
echo "contato $NR@gm""ail.com" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "noreply-de-dominio-pessoal-no-conteudo" vaza "$R"

R=$(novo_repo noreply-pessoal-autor); base_limpa "$R"
echo "x" > "$R/a.txt"; git -C "$R" add -A
git -C "$R" -c user.email="$NR@gm""ail.com" commit -q -m "feat: a"
esperar "noreply-de-dominio-pessoal-como-autor" vaza "$R"

R=$(novo_repo noreply-fornecedor-autor); base_limpa "$R"
echo "x" > "$R/a.txt"; git -C "$R" add -A
git -C "$R" -c user.email="$NR@anthro""pic.com" commit -q -m "feat: a"
esperar "noreply-de-fornecedor-como-autor" vaza "$R"

R=$(novo_repo noreply-github-autor); base_limpa "$R"
echo "x" > "$R/a.txt"; git -C "$R" add -A
git -C "$R" -c user.email="$NR@git""hub.com" commit -q -m "feat: a"
esperar "noreply-do-github-como-committer" limpo "$R"

R=$(novo_repo coautoria); base_limpa "$R"
commitar "$R" "feat: x

Co-Authored-By: Claude <$NR@anthro""pic.com>"
esperar "coautoria-de-fornecedor-na-mensagem" limpo "$R"

R=$(novo_repo noreply-sufixo); base_limpa "$R"
echo "contato $NR@anthro""pic.com.empresa""real.com" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "noreply-com-sufixo-enganoso" vaza "$R"

# --- o git deixa de mostrar ao portão bytes que serão públicos
R=$(novo_repo binario-email); base_limpa "$R"
printf 'x\000 fale com %s\n' "$PESSOAL" > "$R/anexo.bin"; commitar "$R" "docs: anexo"
esperar "email-pessoal-em-arquivo-binario" vaza "$R"

R=$(novo_repo binario-cpf); base_limpa "$R"
printf 'x\000 titular %s\n' "$CPF" > "$R/anexo.bin"; commitar "$R" "docs: anexo"
esperar "cpf-em-arquivo-binario" vaza "$R"

R=$(novo_repo binario-segredo); base_limpa "$R"
printf 'x\000 token=%s\n' "$SEG2" > "$R/anexo.bin"; commitar "$R" "docs: anexo"
esperar "segredo-em-arquivo-binario" vaza "$R"

R=$(novo_repo menos-diff); base_limpa "$R"
echo "*.txt -di""ff" > "$R/.gitattributes"
echo "fale com $PESSOAL" > "$R/contato.txt"; commitar "$R" "docs: contato"
esperar "arquivo-com-atributo-menos-diff" vaza "$R"

R=$(novo_repo arquivo-grande); base_limpa "$R"
git -C "$R" config core.bigFileThreshold 10
echo "fale com $PESSOAL e mais texto para passar do limite" > "$R/contato.txt"; commitar "$R" "docs: contato"
esperar "arquivo-acima-do-limite-de-diff" vaza "$R"

R=$(novo_repo gitleaks-allow); base_limpa "$R"
echo "token=$SEG2 # gitleaks:""allow" > "$R/config.txt"; commitar "$R" "feat: config"
esperar "segredo-com-comentario-de-permissao" vaza "$R"

R=$(novo_repo raso-origem); base_limpa "$R"
echo "fale com $PESSOAL" > "$R/contato.md"; commitar "$R" "docs: contato"
git -C "$R" rm -q contato.md; commitar "$R" "fix: remove contato"
git clone -q --depth 1 "file://$R" "$RAIZ_TMP/raso" 2>/dev/null
esperar "repositorio-raso" indeterminado "$RAIZ_TMP/raso"

R=$(novo_repo parcial-origem); base_limpa "$R"
git -C "$R" config uploadpack.allowFilter true
git -C "$R" config uploadpack.allowAnySHA1InWant true
echo "outro arquivo" > "$R/b.md"; commitar "$R" "docs: b"
git clone -q --no-checkout --filter=blob:none "file://$R" "$RAIZ_TMP/parcial" 2>/dev/null
esperar "clone-parcial" indeterminado "$RAIZ_TMP/parcial"

R=$(novo_repo substituido); base_limpa "$R"
echo "token=$SEG2" > "$R/config.txt"; commitar "$R" "feat: config"
VAZADO=$(git -C "$R" rev-parse HEAD)
git -C "$R" rm -q config.txt; commitar "$R" "fix: remove config"
git -C "$R" replace "$VAZADO" "$(git -C "$R" rev-parse "$VAZADO~1")"
esperar "objeto-substituido-por-replace" vaza "$R"

R=$(novo_repo submodulo); base_limpa "$R"
git -C "$R" update-index --add --cacheinfo "160000,$(git -C "$R" rev-parse HEAD),externo"
git -C "$R" commit -q -m "chore: adiciona externo"
git -C "$R" rm -q --cached externo; git -C "$R" commit -q -m "chore: remove externo"
esperar "submodulo-no-historico" vaza "$R"

R=$(novo_repo lfs-atributo); base_limpa "$R"
echo "*.bin fil""ter=lfs diff=lfs merge=lfs -text" > "$R/.gitattributes"; commitar "$R" "chore: lfs"
esperar "atributo-de-lfs" vaza "$R"

R=$(novo_repo lfs-ponteiro); base_limpa "$R"
printf 'version https://git-lfs.git''hub.com/spec/v1\noid sha256:%s\nsize 10\n' "0000000000000000000000000000000000000000000000000000000000000000" > "$R/a.bin"
commitar "$R" "docs: ponteiro"
esperar "ponteiro-de-lfs" vaza "$R"

# --- arquivos que fazem o próprio gitleaks calar: ignore, baseline, configuração alternativa
CFG_REPO="$AQUI/../../.gitleaks.toml"
impressao_digital() { # repo -> primeira impressão digital achada pelo gitleaks cru
  ( cd "$RAIZ_TMP" && gitleaks git "$1" --config "$CFG_REPO" --log-opts="--all -m" --redact --no-banner --no-color \
      --report-format json --report-path "$RAIZ_TMP/rel.json" >/dev/null 2>&1 )
  grep -o '"Fingerprint": *"[^"]*"' "$RAIZ_TMP/rel.json" | head -1 | sed 's/.*: *"//;s/"$//'
}

R=$(novo_repo ignore-versionado); base_limpa "$R"
echo "token=$SEG2" > "$R/config.txt"; commitar "$R" "feat: config"
impressao_digital "$R" > "$R/.gitleaksignore"; commitar "$R" "chore: ignore"
esperar "gitleaksignore-versionado" vaza "$R"

R=$(novo_repo ignore-na-arvore); base_limpa "$R"
echo "token=$SEG2" > "$R/config.txt"; commitar "$R" "feat: config"
impressao_digital "$R" > "$R/.gitleaksignore"
esperar "gitleaksignore-so-na-arvore" vaza "$R"

R=$(novo_repo baseline); base_limpa "$R"
echo "[]" > "$R/gitleaks-baseline.json"; commitar "$R" "chore: baseline"
esperar "baseline-do-gitleaks-versionado" vaza "$R"

R=$(novo_repo config-alternativa); base_limpa "$R"
echo "title = \"x\"" > "$R/gitleaks-alt.toml"; commitar "$R" "chore: config"
esperar "config-alternativa-do-gitleaks-versionada" vaza "$R"

# o ignore do diretório de execução (padrão ".") não pode calar o portão
R=$(novo_repo ignore-cwd); base_limpa "$R"
echo "token=$SEG2" > "$R/config.txt"; commitar "$R" "feat: config"
D="$RAIZ_TMP/cwd-com-ignore"; mkdir -p "$D"
impressao_digital "$R" > "$D/.gitleaksignore"
( cd "$D" && gitleaks git "$R" --config "$CFG_REPO" --log-opts="--all -m" --redact --no-banner --no-color --exit-code 1 >/dev/null 2>&1 )
if [ $? -eq 0 ]; then echo "PASSOU controle-positivo-ignore-suprime"; else echo "FALHOU controle-positivo-ignore-suprime"; FALHAS=$((FALHAS+1)); fi
cd "$D" || exit 2
esperar "gitleaksignore-no-diretorio-de-execucao" vaza "$R"
cd "$AQUI" || exit 2

# --- o resultado não pode depender do diretório de onde o portão é chamado
graft_oculta() { # repo: o commit com o vazamento some do histórico lido pelo git
  echo "token=$SEG2" > "$1/config.txt"; commitar "$1" "feat: config"
  echo "fim" > "$1/fim.txt"; commitar "$1" "feat: fim"
  echo "$(git -C "$1" rev-parse HEAD) $(git -C "$1" rev-parse HEAD~2)" > "$1/.git/info/grafts"
}

R=$(novo_repo grafts-fora); base_limpa "$R"; graft_oculta "$R"
esperar "grafts-ocultando-commit" indeterminado "$R"

R=$(novo_repo grafts-dentro); base_limpa "$R"; graft_oculta "$R"
cd "$R" || exit 2
esperar "grafts-ocultando-commit-chamado-de-dentro" indeterminado "$R"
cd "$AQUI" || exit 2

R=$(novo_repo relativo); base_limpa "$R"
echo "token=$SEG2" > "$R/config.txt"; commitar "$R" "feat: config"
cd "$RAIZ_TMP" || exit 2
esperar "repo-passado-como-caminho-relativo" vaza "relativo"
cd "$R" || exit 2
esperar "repo-passado-como-ponto" vaza "."
cd "$AQUI" || exit 2

# diff que o git mostra não é o conteúdo: textconv e driver externo escondem o vazamento do `git log -p` comum
R=$(novo_repo textconv); base_limpa "$R"
echo "*.txt diff=oculta" > "$R/.gitattributes"
git -C "$R" config diff.oculta.textconv "echo limpo #"
echo "fale com $PESSOAL" > "$R/contato.txt"; commitar "$R" "docs: contato"
esperar "textconv-escondendo-vazamento" vaza "$R"

R=$(novo_repo diff-externo); base_limpa "$R"
git -C "$R" config diff.external "true"
echo "fale com $PESSOAL" > "$R/contato.txt"; commitar "$R" "docs: contato"
esperar "diff-externo-escondendo-vazamento" vaza "$R"

# --- configuração ambiente do git (global, local do repo, variáveis) não pode mudar o que o portão lê
GCFG="$RAIZ_TMP/gitconfig-global"

R=$(novo_repo cor-local); base_limpa "$R"
echo "titular $CPF" > "$R/dados.md"; commitar "$R" "docs: dados"
git -C "$R" config color.ui always
esperar "cpf-com-color-ui-always-local" vaza "$R"

R=$(novo_repo cor-global); base_limpa "$R"
echo "titular $CPF" > "$R/dados.md"; commitar "$R" "docs: dados"
printf '[color]\n\tui = always\n' > "$GCFG"
GIT_CONFIG_GLOBAL="$GCFG" esperar "cpf-com-color-ui-always-global" vaza "$R"

R=$(novo_repo cor-diff-local); base_limpa "$R"
echo "fale com $PESSOAL" > "$R/contato.md"; commitar "$R" "docs: contato"
git -C "$R" config color.diff always
esperar "email-com-color-diff-always-local" vaza "$R"

R=$(novo_repo noprefix); base_limpa "$R"
echo "fale com $PESSOAL" > "$R/contato.md"; commitar "$R" "docs: contato"
git -C "$R" config diff.noprefix true
esperar "email-com-diff-noprefix" vaza "$R"

R=$(novo_repo mailmap); base_limpa "$R"
echo "x" > "$R/a.txt"; git -C "$R" add -A
git -C "$R" -c user.email="fulano""@redeide""ia.com.br" commit -q -m "feat: a"
echo "Teste <$EMAIL_LIMPO> <fulano""@redeide""ia.com.br>" > "$R/.mailmap"
git -C "$R" config log.mailmap true
esperar "autor-reescrito-por-mailmap" vaza "$R"

R=$(novo_repo quotepath); base_limpa "$R"
mkdir -p "$R/pasta-proibida-á"; echo "x" > "$R/pasta-proibida-á/a.txt"; commitar "$R" "chore: pasta"
git -C "$R" rm -q -r "pasta-proibida-á"; commitar "$R" "chore: remove pasta"
git -C "$R" config core.quotePath true
esperar "nome-de-arquivo-com-acento-proibido" vaza "$R"

R=$(novo_repo info-attributes); base_limpa "$R"
echo "*.txt -di""ff" > "$R/.git/info/attributes"
echo "titular $CPF" > "$R/dados.txt"; commitar "$R" "docs: dados"
esperar "atributo-em-info-attributes" vaza "$R"

R=$(novo_repo fsmonitor); base_limpa "$R"
printf '#!/bin/sh\ntouch "%s"\n' "$RAIZ_TMP/fsmonitor-executou" > "$RAIZ_TMP/hook-fsmonitor.sh"; chmod +x "$RAIZ_TMP/hook-fsmonitor.sh"
git -C "$R" config core.fsmonitor "$RAIZ_TMP/hook-fsmonitor.sh"
PUBLIC_GATE_EXTRA_CONFIG="$EXTRA_SELFTEST" bash "$GATE" "$R" >/dev/null 2>&1
TAB="$(printf '\t')"
NL="$(printf '\n_')"; NL="${NL%_}"
USR="usu""ario"; PW="sen""ha"

# commit raiz: o segredo só existe no primeiro commit, e log.showRoot=false o tira de todo diff
R=$(novo_repo raiz); git -C "$R" config log.showRoot false
echo "token=$SEG2" > "$R/config.txt"; commitar "$R" "chore: inicio"
git -C "$R" rm -q config.txt; commitar "$R" "fix: remove config"
esperar "segredo-so-no-commit-raiz-com-showroot-false" vaza "$R"

# nomes com TAB e com quebra de linha: o git escapa o caminho mesmo com core.quotePath=false
R=$(novo_repo nome-tab); base_limpa "$R"
mkdir -p "$R/.claude"; echo "x" > "$R/.claude/a${TAB}b.md"; commitar "$R" "chore: config"
esperar "caminho-proibido-com-tab-no-nome" vaza "$R"

R=$(novo_repo nome-tab-apagado); base_limpa "$R"
mkdir -p "$R/.claude"; echo "x" > "$R/.claude/a${TAB}b.md"; commitar "$R" "chore: config"
git -C "$R" rm -q -r .claude; commitar "$R" "fix: remove config"
esperar "caminho-proibido-com-tab-apagado-depois" vaza "$R"

R=$(novo_repo nome-quebra); base_limpa "$R"
echo "x" > "$R/a${NL}b.md"; commitar "$R" "docs: nome estranho"
esperar "nome-de-arquivo-com-quebra-de-linha" vaza "$R"

# credencial em configuração local, em qualquer chave
R=$(novo_repo pushurl); base_limpa "$R"
git -C "$R" remote add origin "https://servidor.example.com/x.git"
git -C "$R" config remote.origin.pushurl "https://$USR:$PW@servidor.example.com/x.git"
esperar "credencial-no-pushurl" vaza "$R"

R=$(novo_repo insteadof); base_limpa "$R"
git -C "$R" config "url.https://$USR:$PW@servidor.example.com/.insteadOf" "https://servidor.example.com/"
esperar "credencial-em-insteadof" vaza "$R"

R=$(novo_repo submodule-url); base_limpa "$R"
git -C "$R" config submodule.externo.url "https://$USR:$PW@servidor.example.com/y.git"
esperar "credencial-em-url-de-submodulo" vaza "$R"

R=$(novo_repo extraheader); base_limpa "$R"
git -C "$R" config "http.https://servidor.example.com/.extraHeader" "AUTHORIZATION: basic dXN1YXJpbzpzZW5oYQ=="
esperar "credencial-em-extraheader" vaza "$R"

R=$(novo_repo helper-store); base_limpa "$R"
git -C "$R" config credential.helper "store --file=/caminho/qualquer"
esperar "credencial-em-helper-store" vaza "$R"

# a trava de extração: um git que devolve diff vazio tem de dar exit 2, nunca limpo
R=$(novo_repo trava); base_limpa "$R"
echo "titular $CPF" > "$R/dados.md"; commitar "$R" "docs: dados"
GIT_REAL="$(command -v git)"
mkdir -p "$RAIZ_TMP/fakebin"
cat > "$RAIZ_TMP/fakebin/git" <<SH
#!/bin/sh
case " \$* " in *" log "*" -p "*) exit 0 ;; esac
exec "$GIT_REAL" "\$@"
SH
chmod +x "$RAIZ_TMP/fakebin/git"
PATH="$RAIZ_TMP/fakebin:$PATH" esperar "trava-de-extracao-dispara" indeterminado "$R"

if [ ! -e "$RAIZ_TMP/fsmonitor-executou" ]; then echo "PASSOU config-local-nao-executa-programa"; else echo "FALHOU config-local-nao-executa-programa"; FALHAS=$((FALHAS+1)); fi

# --- configuração do alvo que cala o gitleaks (rodada da fase, plano 01-20): allowlist, e config sem os detectores padrão
CFG_REAL="$AQUI/../../.gitleaks.toml"
R=$(novo_repo allowlist-na-config); base_limpa "$R"
{ cat "$CFG_REAL"; printf '\n[allowlist]\nregexes = [\x27\x27\x27.*\x27\x27\x27]\n'; } > "$R/.gitleaks.toml"
echo "token=$SEG" > "$R/config.txt"; commitar "$R" "feat: config"
esperar "allowlist-na-config-do-alvo" vaza "$R"

R=$(novo_repo allowlist-de-regra); base_limpa "$R"
{ cat "$CFG_REAL"; printf '\n[[rules.allowlists]]\nregexes = [\x27\x27\x27.*\x27\x27\x27]\n'; } > "$R/.gitleaks.toml"
echo "contato: dev""@ide""iabusiness.com.br" > "$R/contato.md"; commitar "$R" "docs: contato"
esperar "allowlist-por-regra-na-config-do-alvo" vaza "$R"

R=$(novo_repo config-sem-padrao); base_limpa "$R"
perl -0pe 's/\[extend\]\s*useDefault = true\s*//' "$CFG_REAL" > "$R/.gitleaks.toml"
echo "token=$SEG" > "$R/config.txt"; commitar "$R" "feat: config"
esperar "config-do-alvo-sem-detectores-padrao" indeterminado "$R"

# --- ref cujo objeto final não é commit: `git log --all` não a percorre, mas ela é publicada com `git push --tags`
R=$(novo_repo tag-blob); base_limpa "$R"
echo "token=$SEG" > "$RAIZ_TMP/segredo-solto.txt"
BLOB=$(git -C "$R" hash-object -w "$RAIZ_TMP/segredo-solto.txt")
git -C "$R" tag etiqueta-blob "$BLOB"
esperar "tag-aponta-para-blob" vaza "$R"

R=$(novo_repo tag-anotada-blob); base_limpa "$R"
BLOB=$(git -C "$R" hash-object -w "$RAIZ_TMP/segredo-solto.txt")
git -C "$R" tag -a -m "x" etiqueta-anotada "$BLOB"
esperar "tag-anotada-aponta-para-blob" vaza "$R"

R=$(novo_repo tag-arvore); base_limpa "$R"
echo "token=$SEG" > "$R/oculto.txt"; git -C "$R" add oculto.txt
ARV=$(git -C "$R" write-tree); git -C "$R" reset -q
git -C "$R" tag etiqueta-arvore "$ARV"
esperar "tag-aponta-para-arvore" vaza "$R"

R=$(novo_repo tag-commit-limpa); base_limpa "$R"
git -C "$R" tag etiqueta-leve; git -C "$R" tag -a -m "ok" etiqueta-anotada
esperar "tags-de-commit-continuam-limpas" limpo "$R"

# --- tag anotada que aponta para outra tag anotada cuja ref própria foi apagada: o objeto interno é publicado com a externa
R=$(novo_repo tag-aninhada); base_limpa "$R"
git -C "$R" tag -a -m "token=$SEG" interna
git -C "$R" -c advice.nestedTag=false tag -a -m "externa" externa interna
git -C "$R" tag -d interna >/dev/null
esperar "tag-aninhada-com-segredo-na-mensagem-interna" vaza "$R"

R=$(novo_repo tag-aninhada-autor); base_limpa "$R"
git -C "$R" -c user.email="fulano""@redeide""ia.com.br" tag -a -m "interna" interna
git -C "$R" -c advice.nestedTag=false tag -a -m "externa" externa interna
git -C "$R" tag -d interna >/dev/null
esperar "tag-aninhada-com-tagger-corporativo" vaza "$R"

# --- configuração do alvo sem as regras internas obrigatórias (retirada por engano): leitura cega, exit 2
R=$(novo_repo config-sem-regra-interna); base_limpa "$R"
perl -0pe 's/\[\[rules\]\]\s*id = "termo-interno".*?\x27\x27\x27\n//s' "$CFG_REAL" > "$R/.gitleaks.toml"
commitar "$R" "chore: config"
esperar "config-do-alvo-sem-regra-interna-obrigatoria" indeterminado "$R"

[ $FALHAS -eq 0 ] || { echo "autoteste: $FALHAS falha(s)" >&2; exit 1; }
exit 0
