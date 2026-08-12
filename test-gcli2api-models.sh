#!/usr/bin/env bash
# 测试 gcli2api Antigravity 上 3.6 flash / 3.1 pro 各档连通性
#
# 用法:
#   ./test-gcli2api-models.sh
#   bash test-gcli2api-models.sh          # 推荐；不要用 sh（无 process substitution）
#   BASE=http://10.8.0.200:7861 API_KEY=pwd ./test-gcli2api-models.sh
#   ./test-gcli2api-models.sh --anthropic
#   ./test-gcli2api-models.sh --all-variants
#   ./test-gcli2api-models.sh gemini-3.1-pro-low gemini-3.6-flash-tiered

# `sh this-script` ignores the shebang. On macOS, /bin/sh is often bash in
# POSIX mode (BASH_VERSION set, but process substitution disabled). Re-exec
# under bash once so arrays / [[ / <() all work.
if [ "${_GCLI2API_BASH_REEXEC:-}" != 1 ]; then
  if [ -z "${BASH_VERSION:-}" ] || ! eval 'true <(:)' 2>/dev/null; then
    _GCLI2API_BASH_REEXEC=1 exec bash "$0" "$@"
  fi
fi

set -uo pipefail

BASE="${BASE:-http://10.8.0.200:7861}"
API_KEY="${API_KEY:-pwd}"
TIMEOUT="${TIMEOUT:-30}"
TEST_ANTHROPIC=0
ALL_VARIANTS=0
CUSTOM_MODELS=()

for arg in "$@"; do
  case "$arg" in
    --anthropic) TEST_ANTHROPIC=1 ;;
    --all-variants) ALL_VARIANTS=1 ;;
    -h|--help)
      cat <<'EOF'
Usage: ./test-gcli2api-models.sh [options] [model...]

Options:
  --anthropic      also POST /antigravity/v1/messages
  --all-variants   include 假流式/ and 流式抗截断/ from /models list
  -h, --help       show this help

Env:
  BASE      default http://10.8.0.200:7861
  API_KEY   default pwd
  TIMEOUT   default 30 (seconds)
EOF
      exit 0
      ;;
    *) CUSTOM_MODELS+=("$arg") ;;
  esac
done

DEFAULT_MODELS=(
  gemini-3.1-pro-low
  gemini-3.1-pro-high
  gemini-3.6-flash-low
  gemini-3.6-flash-medium
  gemini-3.6-flash-high
  gemini-3.6-flash-tiered
)

if [[ ${#CUSTOM_MODELS[@]} -gt 0 ]]; then
  MODELS=("${CUSTOM_MODELS[@]}")
elif [[ "$ALL_VARIANTS" -eq 1 ]]; then
  MODELS=()
  # Prefer a temp file over process substitution so `sh script` / POSIX bash work.
  _models_list=$(mktemp)
  curl -sS -m "$TIMEOUT" -H "Authorization: Bearer ${API_KEY}" \
    "${BASE}/antigravity/v1/models" \
    | python3 -c "
import json,sys
d=json.load(sys.stdin)
for i in sorted(m['id'] for m in d.get('data',[])):
    if '3.6-flash' in i or '3.1-pro' in i:
        print(i)
" >"$_models_list"
  while IFS= read -r id; do
    [[ -n "$id" ]] && MODELS+=("$id")
  done <"$_models_list"
  rm -f "$_models_list"
else
  MODELS=("${DEFAULT_MODELS[@]}")
fi

snippet_openai() {
  python3 -c "
import json,sys
raw=sys.stdin.read()
try:
  d=json.loads(raw)
  if 'error' in d:
    e=d['error']
    print(str(e.get('message') or e.get('status') or e)[:70]); sys.exit(0)
  c=(d.get('choices') or [{}])[0].get('message',{}).get('content') or ''
  print((c or '(empty content)')[:60].replace(chr(10),' '))
except Exception:
  print((raw or '')[:70].replace(chr(10),' '))
"
}

snippet_anthropic() {
  python3 -c "
import json,sys
raw=sys.stdin.read()
try:
  d=json.loads(raw)
  if 'error' in d:
    e=d['error']
    if isinstance(e, dict):
      print(str(e.get('message') or e.get('status') or e)[:70])
    else:
      print(str(e)[:70])
    sys.exit(0)
  parts=d.get('content') or []
  texts=[p.get('text','') for p in parts if isinstance(p,dict) and p.get('type')=='text']
  print((' '.join(texts) or d.get('stop_reason') or '(empty)')[:60].replace(chr(10),' '))
except Exception:
  print((raw or '')[:70].replace(chr(10),' '))
"
}

echo "=============================================="
echo " gcli2api Antigravity 模型连通性测试"
echo " BASE     = ${BASE}"
echo " KEY      = ${API_KEY:0:3}***"
echo " TIMEOUT  = ${TIMEOUT}s"
echo " ANTHROPIC= ${TEST_ANTHROPIC}"
echo " models   = ${#MODELS[@]}"
echo "=============================================="
echo

if ! curl -sS -m 5 -o /dev/null \
  -H "Authorization: Bearer ${API_KEY}" \
  "${BASE}/antigravity/v1/models"; then
  echo "ERROR: 无法连接 ${BASE}/antigravity/v1/models"
  exit 1
fi
echo "[ok] models endpoint reachable"
echo

printf "%-10s %-6s %-8s %-42s %s\n" "PROTO" "HTTP" "TIME" "MODEL" "SNIPPET"
printf "%-10s %-6s %-8s %-42s %s\n" "----------" "------" "--------" "------------------------------------------" "-------"

ok=0
fail=0

for model in "${MODELS[@]}"; do
  out=$(mktemp)
  metrics=$(curl -sS -m "$TIMEOUT" -o "$out" -w "%{http_code} %{time_total}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${model}\",\"max_tokens\":32,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"ping. Reply with: pong only.\"}]}" \
    "${BASE}/antigravity/v1/chat/completions" 2>/dev/null || echo "000 0")
  http=$(echo "$metrics" | awk '{print $1}')
  time=$(echo "$metrics" | awk '{printf "%.2f", $2}')
  snippet=$(snippet_openai <"$out")
  rm -f "$out"
  if [[ "$http" == "200" ]]; then ok=$((ok+1)); else fail=$((fail+1)); fi
  printf "%-10s %-6s %-8s %-42s %s\n" "openai" "$http" "${time}s" "$model" "$snippet"

  if [[ "$TEST_ANTHROPIC" -eq 1 ]]; then
    out=$(mktemp)
    metrics=$(curl -sS -m "$TIMEOUT" -o "$out" -w "%{http_code} %{time_total}" \
      -H "x-api-key: ${API_KEY}" \
      -H "anthropic-version: 2023-06-01" \
      -H "Content-Type: application/json" \
      -d "{\"model\":\"${model}\",\"max_tokens\":32,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"ping. Reply with: pong only.\"}]}" \
      "${BASE}/antigravity/v1/messages" 2>/dev/null || echo "000 0")
    http=$(echo "$metrics" | awk '{print $1}')
    time=$(echo "$metrics" | awk '{printf "%.2f", $2}')
    snippet=$(snippet_anthropic <"$out")
    rm -f "$out"
    if [[ "$http" == "200" ]]; then ok=$((ok+1)); else fail=$((fail+1)); fi
    printf "%-10s %-6s %-8s %-42s %s\n" "anthropic" "$http" "${time}s" "$model" "$snippet"
  fi
done

echo
echo "=============================================="
echo " done: ok=${ok} fail=${fail}"
echo "=============================================="

[[ "$fail" -eq 0 ]]
