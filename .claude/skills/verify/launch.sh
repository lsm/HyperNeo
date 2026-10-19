#!/bin/bash
set -euo pipefail
PORT=${1:?usage: launch.sh <port> [run-dir]}
RUN=${2:-$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")}
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
[ "$PORT" = 8399 ] && { echo "refusing 8399: that is the real daemon's port"; exit 1; }
for p in "$PORT" 8000; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is busy"; exit 1; fi
done
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
clean_env=(env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1)
cd "$REPO"
"${clean_env[@]}" bun .claude/skills/verify/mock-api.ts < /dev/null > "$RUN/mock-api.log" 2>&1 &
echo $! > "$RUN/mock-api.pid"
"${clean_env[@]}" HYPERNEO_DATA_DIR="$RUN/data" \
  /usr/sbin/taskpolicy -b /usr/bin/nice -n 19 \
  bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
echo $! > "$RUN/daemon.pid"
for _ in $(seq 1 120); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "ready: http://127.0.0.1:$PORT  run dir: $RUN"
    exit 0
  fi
  sleep 1
done
echo "daemon did not become ready; see $RUN/daemon.log"
exit 1
