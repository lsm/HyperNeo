#!/usr/bin/env bash
set -euo pipefail
EVIDENCE=${1:?absolute evidence directory required}
: "${RUN:?run through with-run.sh}"
[[ "$EVIDENCE" = /* ]] || exit 64
if [[ $(uname -s) == Darwin ]]; then
  bash .claude/skills/verify/resource-check.sh
fi
mkdir "$EVIDENCE"
mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/data" "$RUN/bin" "$RUN/evidence"
touch "$RUN/.preserve-run"
cp .claude/skills/verify/gh-stub.sh "$RUN/bin/gh"
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
[[ "$PORT" != 8399 ]] || exit 1
ENV=(env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH"
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=warn)
PID=""
STANDALONE_PID=""
cleanup() {
  STATUS=$?
  trap - EXIT
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [[ -n "$STANDALONE_PID" ]]; then
    kill "$STANDALONE_PID" 2>/dev/null || true
    wait "$STANDALONE_PID" 2>/dev/null || true
  fi
  cp -R "$RUN/evidence/." "$EVIDENCE/"
  cp "$RUN/daemon.log" "$EVIDENCE/daemon.log"
  printf '{"exitCode":%s,"serverStopped":true}\n' "$STATUS" > "$EVIDENCE/run-status.json"
  rm "$RUN/.preserve-run"
  exit "$STATUS"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
"${ENV[@]}" bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  </dev/null >"$RUN/daemon.log" 2>&1 &
PID=$!
for _ in $(seq 1 120); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/"
for _ in $(seq 1 30); do
  [[ -S "$RUN/data/session-door.sock" ]] && break
  sleep 1
done
PAIR_CODE=$("${ENV[@]}" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" \
  bun packages/cli/main.ts pair --kind human | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
PAIR_CODE="$PAIR_CODE" NODE_PATH="${NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  VERIFY_BROWSER="${VERIFY_BROWSER:-}" node .claude/skills/verify/neo-root-entry-web.mjs "$PORT" "$RUN"
if grep -Fq "$PAIR_CODE" "$RUN/daemon.log"; then
  echo 'pairing code appeared in daemon log' >&2
  exit 1
fi
PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
[[ "$PORT" != 8399 ]] || exit 1
(cd packages/web && exec "${ENV[@]}" PORT="$PORT" bun src/server-prod.ts) >"$RUN/evidence/standalone.log" 2>&1 &
STANDALONE_PID=$!
for _ in $(seq 1 30); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 1
done
for path in '/' '/?entry=1' '/neo?entry=1'; do
  curl -fs "http://127.0.0.1:$PORT$path" > "$RUN/evidence/standalone-entry.html"
  grep -q '<title>Neo ·' "$RUN/evidence/standalone-entry.html" || { echo "Expected Neo at $path" >&2; exit 1; }
done
curl -fs "http://127.0.0.1:$PORT/sessions?entry=1" | grep -q '<title>HyperNeo'
curl -sD "$RUN/evidence/standalone-redirect.headers" -o /dev/null "http://127.0.0.1:$PORT/neo/?entry=1"
grep -q '308' "$RUN/evidence/standalone-redirect.headers"
grep -qi 'location: .*/neo?entry=1' "$RUN/evidence/standalone-redirect.headers"
printf '{"verified":true,"neoEntries":3,"legacyEntry":true,"canonicalRedirect":true}\n' > "$RUN/evidence/standalone.json"
