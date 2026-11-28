#!/bin/bash
# Daemon A starts work on attached daemon B with an explicit model and effort.
# Usage: remote-start-model.sh <portA> <portB> (never 8399). Codes and credentials stay
# in shell variables and are never printed.
set -euo pipefail
PA=${1:?usage: remote-start-model.sh <portA> <portB>}
PB=${2:?usage: remote-start-model.sh <portA> <portB>}
for P in "$PA" "$PB" "${VERIFY_MOCK_PORT:-8000}"; do
  [ "$P" = 8399 ] && { echo "refusing 8399"; exit 1; }
  lsof -nP -iTCP:"$P" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $P is busy"; exit 1; }
done
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/remote-start-model.XXXXXX")
cd "$ROOT"
BUNPATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
start() {
  mkdir -p "$RUN/$1/home" "$RUN/$1/data"
  env -i HOME="$RUN/$1/home" PATH="$BUNPATH" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
    HYPERNEO_USE_DEV_PROXY=1 ${VERIFY_MOCK_PORT:+VERIFY_MOCK_PORT=$VERIFY_MOCK_PORT} HYPERNEO_DATA_DIR="$RUN/$1/data" \
    bun run packages/cli/main.ts --port "$2" --host 127.0.0.1 --db-path "$RUN/$1/data/daemon.db" \
    < /dev/null > "$RUN/$1/daemon.log" 2>&1 &
  echo $!
}
mkdir -p "$RUN/mock"
env -i HOME="$RUN/mock" PATH="$BUNPATH" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
  ${VERIFY_MOCK_PORT:+VERIFY_MOCK_PORT=$VERIFY_MOCK_PORT} \
  bun .claude/skills/verify/mock-api.ts < /dev/null > "$RUN/mock/mock-api.log" 2>&1 &
PIDM=$!
PIDA=$(start a "$PA")
PIDB=$(start b "$PB")
cleanup() {
  kill $PIDA $PIDB $PIDM 2>/dev/null || true
  wait $PIDA $PIDB $PIDM 2>/dev/null || true
  if [ "${VERIFY_KEEP_RUN:-0}" = 1 ]; then echo "run dir: $RUN"; else rm -rf "$RUN"; fi
}
trap cleanup EXIT
for P in "$PA" "$PB"; do for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$P/" && break; sleep 1; done; done
for D in a b; do for _ in $(seq 1 30); do [ -S "$RUN/$D/data/session-door.sock" ] && break; sleep 1; done; done
cli_b() {
  env -i HOME="$RUN/b/home" PATH="$BUNPATH" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test \
    HYPERNEO_DATA_DIR="$RUN/b/data" HYPERNEO_SESSION_DOOR="$RUN/b/data/session-door.sock" \
    bun run packages/cli/main.ts "$@"
}
field() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
on() { HYPERNEO_DATA_DIR="$RUN/$1/data" VERIFY_PORT="$2" bun .claude/skills/verify/rpc.ts "${@:3}"; }

on b "$PB" rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' > /dev/null
MODEL=${VERIFY_REMOTE_MODEL:-$(on b "$PB" rpc:models.list '{}' | field "d['reply']['models'][0]['id']")}
mkdir -p "$RUN/b/home/project"
CODE=$(cli_b pair --kind daemon --name ignored | field "d['code']")
ATTACH=$(printf '{"daemonId":"b","url":"ws://127.0.0.1:%s/ws","code":"%s"}' "$PB" "$CODE")
echo "attach A to B: $(on a "$PA" daemon.attach "$ATTACH" | field "d['reply']['kind']")"
echo "B's catalog identity, read from A: $(on a "$PA" work.adapters '{"daemon":"b"}' | python3 -c '
import json, sys
print({a["id"]: a.get("identity") for a in json.load(sys.stdin)["reply"]["value"] if a["id"] in ("hyperneo", "claude-desktop")})')"
start_on_b() {
  on a "$PA" work.start "$(printf '{"adapter":"%s","place":{"machine":"%s","name":"project","folder":"%s","daemon":"b"},"title":"remote model","message":"hello","model":"%s","effort":"high"}' \
    "$1" "$(hostname)" "$RUN/b/home/project" "$MODEL")" | python3 -c '
import json, sys
r = json.load(sys.stdin)["reply"]
v = r.get("value") or {}
print({"ok": r.get("ok"), "reason": r.get("reason"), "detail": r.get("detail"), "model": v.get("model"), "effort": v.get("effort"), "daemon": (v.get("ref") or {}).get("daemon")})'
}
echo "requested on B: model=$MODEL effort=high"
echo "hyperneo start on B: $(start_on_b hyperneo)"
echo "B's sessions on that model: $(sqlite3 -readonly "$RUN/b/data/daemon.db" "SELECT COUNT(*) FROM sessions WHERE json_extract(config, '$.model') = '$MODEL'")"
