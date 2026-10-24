#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: default-thinking-settings.sh <fresh-absolute-run-dir> [daemon-port] [mock-port]}
PORT=${2:-9391}
MOCK=${3:-9392}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 && "$MOCK" != 8399 && "$PORT" != "$MOCK" ]]
for candidate in "$PORT" "$MOCK"; do
  if lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $candidate is busy" >&2; exit 1; fi
done
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
clean=(env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" NODE_ENV=test TMPDIR="$RUN" HYPERNEO_USE_DEV_PROXY=0)
"${clean[@]}" bun .claude/skills/verify/neo-model-settings-mock.ts "$MOCK" > "$RUN/mock-api.log" 2>&1 &
echo $! > "$RUN/mock-api.pid"
"${clean[@]}" HYPERNEO_DATA_DIR="$RUN/data" ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK" \
  bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
echo $! > "$RUN/daemon.pid"
ready=false
for _ in $(seq 1 60); do
  kill -0 "$(cat "$RUN/daemon.pid")"
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then ready=true; break; fi
  sleep 0.5
done
[[ "$ready" == true ]]
node .claude/skills/verify/default-thinking-settings.mjs "$PORT" "$RUN"
