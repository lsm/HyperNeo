#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-rules-settings.sh <fresh-absolute-run-dir> [daemon-port]}
PORT=${2:-9391}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 ]]
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy" >&2; exit 1; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test TMPDIR="$RUN" HYPERNEO_USE_DEV_PROXY=0 HYPERNEO_DATA_DIR="$RUN/data" \
  bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
echo $! > "$RUN/daemon.pid"
ready=false
for _ in $(seq 1 60); do
  kill -0 "$(cat "$RUN/daemon.pid")"
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then ready=true; break; fi
  sleep 0.5
done
[[ "$ready" == true ]]
node .claude/skills/verify/neo-rules-settings.mjs "$PORT" "$RUN"
