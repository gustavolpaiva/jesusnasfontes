#!/usr/bin/env bash
# Gera os três woff2 da tipografia a partir dos arquivos variáveis do repositório google/fonts,
# num commit fixado em data/tipografia.yaml. Reprodutível: versões e sha256 vêm do registro.
# Uso: pnpm tipografia:gerar
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRO="$RAIZ/data/tipografia.yaml"
VENV="$RAIZ/.venv-tipografia"
ORIGEM="$VENV/origem"
SAIDA="$RAIZ/src/app/tipografia"
FONTTOOLS_VERSAO="4.68.0"
BROTLI_VERSAO="1.2.1"
RECURSOS="kern,liga,smcp,c2sc,lnum,onum,tnum,pnum,ccmp,locl,case,calt,frac"
# Latin-1 mais a pontuação tipográfica usada no português.
UNICODES="U+0020-007E,U+00A0-00FF,U+0152-0153,U+2010-2015,U+2018-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+20AC,U+2212"

[ -s "$REGISTRO" ] || { echo "ERRO: registro ausente ou vazio: $REGISTRO" >&2; exit 1; }
COMMIT="$(awk '/^commit:/ {gsub(/"/, "", $2); print $2; exit}' "$REGISTRO")"
[ -n "$COMMIT" ] || { echo "ERRO: 'commit:' ausente em $REGISTRO" >&2; exit 1; }

# Valor de uma chave logo depois da linha 'arquivo: <caminho>' (ou 'gerado: <nome>') do registro.
valor_depois() { # $1 = chave da linha âncora, $2 = valor da âncora, $3 = chave procurada
  awk -v chave="$1" -v alvo="$2" -v procurada="$3" '
    { linha = $0; sub(/^[ -]+/, "", linha) }
    index(linha, chave ": " alvo) == 1 && length(linha) == length(chave ": " alvo) { achou = 1; next }
    achou && index(linha, procurada ": ") == 1 { sub(procurada ": ", "", linha); gsub(/"/, "", linha); print linha; exit }
  ' "$REGISTRO"
}

if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --quiet --disable-pip-version-check --no-deps \
  "fonttools==$FONTTOOLS_VERSAO" "brotli==$BROTLI_VERSAO"
PY="$VENV/bin/python"
# Data fixa na tabela head: o woff2 sai idêntico bit a bit a cada execução.
export SOURCE_DATE_EPOCH=1763424000

mkdir -p "$ORIGEM" "$SAIDA"
baixar() { # $1 = caminho no google/fonts
  local caminho="$1" destino esperado medido url
  destino="$ORIGEM/$(basename "$(dirname "$caminho")")-$(basename "$caminho")"
  url="https://raw.githubusercontent.com/google/fonts/$COMMIT/${caminho//\[/%5B}"
  url="${url//\]/%5D}"
  esperado="$(valor_depois arquivo "$caminho" sha256)"
  [ -n "$esperado" ] || { echo "ERRO: sem sha256 no registro para $caminho" >&2; exit 1; }
  if [ ! -s "$destino" ]; then
    curl --fail --silent --show-error --location --max-time 120 --output "$destino" "$url"
  fi
  medido="$(shasum -a 256 "$destino" | awk '{print $1}')"
  if [ "$medido" != "$esperado" ]; then
    rm -f "$destino"
    echo "ERRO: sha256 de $caminho difere do registro (esperado $esperado, medido $medido)" >&2
    exit 1
  fi
  echo "$destino"
}

EB_ROMANO="$(baixar "ofl/ebgaramond/EBGaramond[wght].ttf")"
EB_ITALICO="$(baixar "ofl/ebgaramond/EBGaramond-Italic[wght].ttf")"
CORMORANT="$(baixar "ofl/cormorantgaramond/CormorantGaramond[wght].ttf")"
baixar "ofl/ebgaramond/OFL.txt" >/dev/null
baixar "ofl/cormorantgaramond/OFL.txt" >/dev/null

TMP="$(mktemp -d "$VENV/tmp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

gerar() { # $1 = entrada, $2 = limite do eixo de peso, $3 = nome do woff2
  "$PY" -m fontTools.varLib.instancer "$1" "wght=$2" --output "$TMP/instancia.ttf" --quiet
  "$PY" -m fontTools.subset "$TMP/instancia.ttf" \
    --unicodes="$UNICODES" --layout-features="$RECURSOS" --flavor=woff2 \
    --no-hinting --desubroutinize --output-file="$SAIDA/$3"
  rm -f "$TMP/instancia.ttf"
}

gerar "$EB_ROMANO" "400:600" "eb-garamond-400-600.woff2"
gerar "$EB_ITALICO" "400" "eb-garamond-italic-400.woff2"
gerar "$CORMORANT" "600" "cormorant-garamond-600.woff2"

# Licença: as notas de direitos autorais e o texto da licença das duas famílias, copiados sem alteração.
{
  echo "EB Garamond (ofl/ebgaramond/OFL.txt, google/fonts $COMMIT)"
  echo "----------------------------------------------------------------"
  cat "$ORIGEM/ebgaramond-OFL.txt"
  echo
  echo "Cormorant Garamond (ofl/cormorantgaramond/OFL.txt, google/fonts $COMMIT)"
  echo "----------------------------------------------------------------"
  cat "$ORIGEM/cormorantgaramond-OFL.txt"
} >"$SAIDA/OFL.txt"

# Conferência: o versalete verdadeiro (smcp e c2sc) precisa existir nos woff2 gerados.
"$PY" - "$SAIDA" <<'PYEOF'
import sys
from fontTools.ttLib import TTFont
saida = sys.argv[1]
falhou = False
for nome in ("eb-garamond-400-600.woff2", "eb-garamond-italic-400.woff2", "cormorant-garamond-600.woff2"):
    fonte = TTFont(f"{saida}/{nome}")
    recursos = {r.FeatureTag for r in fonte["GSUB"].table.FeatureList.FeatureRecord}
    faltam = {"smcp", "c2sc", "lnum", "onum"} - recursos
    print(f"{nome}: smcp={'smcp' in recursos} c2sc={'c2sc' in recursos} faltam={sorted(faltam) or '-'}")
    if faltam:
        falhou = True
sys.exit(1 if falhou else 0)
PYEOF

# Confere os woff2 gerados com o registro (geração reprodutível).
for nome in eb-garamond-400-600.woff2 eb-garamond-italic-400.woff2 cormorant-garamond-600.woff2; do
  esperado="$(valor_depois gerado "$nome" sha256)"
  medido="$(shasum -a 256 "$SAIDA/$nome" | awk '{print $1}')"
  if [ "$medido" = "$esperado" ]; then
    echo "OK  $nome $medido"
  else
    echo "DIFERE $nome medido=$medido registro=${esperado:-ausente}" >&2
    DIFERIU=1
  fi
done
[ -z "${DIFERIU:-}" ] || { echo "ERRO: woff2 difere do registro; revise e atualize data/tipografia.yaml" >&2; exit 1; }
