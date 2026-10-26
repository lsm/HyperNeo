#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-muted-sessions-settings.sh <fresh-absolute-run-dir> [daemon-port]}
PORT=${2:-9393}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 ]]
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy" >&2; exit 1; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
start_daemon() {
  env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
    NODE_ENV=test TMPDIR="$RUN" HYPERNEO_USE_DEV_PROXY=0 HYPERNEO_DATA_DIR="$RUN/data" \
    bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" >> "$RUN/daemon.log" 2>&1 &
  echo $! > "$RUN/daemon.pid"
  for _ in $(seq 1 60); do
    kill -0 "$(cat "$RUN/daemon.pid")"
    if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then return 0; fi
    sleep 0.5
  done
  return 1
}
stop_daemon() {
  kill "$(cat "$RUN/daemon.pid")"
  while kill -0 "$(cat "$RUN/daemon.pid")" 2>/dev/null; do sleep 0.2; done
}
start_daemon
mkfifo "$RUN/control"
(
  while read -r command < "$RUN/control"; do
    case "$command" in
      stop) stop_daemon; echo stopped > "$RUN/control.ack" ;;
      start) start_daemon; echo started > "$RUN/control.ack" ;;
      done) break ;;
    esac
  done
) &
CONTROL=$!
status=0
node .claude/skills/verify/neo-muted-sessions-settings.mjs "$PORT" "$RUN" || status=$?
kill "$CONTROL" 2>/dev/null || true
exit "$status"
