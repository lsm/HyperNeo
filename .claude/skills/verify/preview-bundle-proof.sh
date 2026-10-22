#!/bin/bash
set -euo pipefail
RUN=${1:?usage: preview-bundle-proof.sh fresh-run-dir [port]}
PORT=${2:-9417}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
[ "$PORT" != 8399 ] || { echo 'refusing live daemon port'; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy"; exit 1; fi
mkdir -p "$RUN/home" "$RUN/evidence"
RUN=$(cd "$RUN" && pwd -P)
cd "$REPO"
OWN_PID=
stop() {
  if [ -n "$OWN_PID" ]; then kill -TERM "$OWN_PID" 2>/dev/null || true; wait "$OWN_PID" || true; OWN_PID=; fi
}
trap stop EXIT
start() {
  env -i HOME="$RUN/home" PATH="$PATH" TMPDIR=/private/tmp NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
    HYPERNEO_DATA_DIR="$RUN/data" bun packages/cli/main.ts --host 127.0.0.1 --port "$PORT" --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
  OWN_PID=$!
  echo "$OWN_PID" > "$RUN/daemon.pid"
  for _ in $(seq 1 60); do
    kill -0 "$OWN_PID" 2>/dev/null || { cat "$RUN/daemon.log"; exit 1; }
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/neo"; then return; fi
    sleep 1
  done
  echo 'isolated daemon readiness failed'; exit 1
}
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test node .claude/skills/verify/preview-bundle-web.mjs seed "$RUN" "$PORT"
start
node .claude/skills/verify/preview-bundle-web.mjs prepare "$RUN" "$PORT"
stop
env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test bun .claude/skills/verify/preview-html-panel-seed.ts "$RUN"
start
node .claude/skills/verify/preview-bundle-web.mjs restart "$RUN" "$PORT"
node .claude/skills/verify/preview-bundle-web.mjs web "$RUN" "$PORT"
VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts rpc:system.health '{}' > "$RUN/evidence/health.json"
curl -fs "http://127.0.0.1:$PORT/neo" > "$RUN/evidence/served-app.html"
stop
printf 'proof passed; synthetic evidence retained in %s\n' "$RUN/evidence"
