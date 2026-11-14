#!/usr/bin/env bash
# Stop then archive a HyperNeo session that a daemon restart left waiting to resume.
set -euo pipefail
RUN=${1:?usage: stop-restart-interrupted.sh <fresh-absolute-run-dir> [port]}
PORT=${2:-9377}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" || "$PORT" = 8399 ]]; then echo 'Use a fresh run directory and an isolated port' >&2; exit 2; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy"; exit 1; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home/workspace" "$RUN/data" "$RUN/tmp" "$RUN/evidence"
DB="$RUN/data/daemon.db"
DAEMON_PID=
clean=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
stop_daemon() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
    DAEMON_PID=
  fi
}
trap stop_daemon EXIT
start_daemon() {
  (cd "$REPO" && exec "${clean[@]}" bun packages/cli/main.ts --host 127.0.0.1 --port "$PORT" \
    --db-path "$DB" >>"$RUN/daemon.log" 2>&1) &
  DAEMON_PID=$!
  for _ in $(seq 1 120); do
    kill -0 "$DAEMON_PID" 2>/dev/null || { tail -20 "$RUN/daemon.log"; exit 1; }
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    sleep 1
  done
  echo 'daemon did not start'; exit 1
}
rpc() { (cd "$REPO" && "${clean[@]}" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"); }

start_daemon
rpc rpc:session.create "{\"workspacePath\":\"$RUN/home/workspace\",\"title\":\"cooldown\"}" \
  >"$RUN/evidence/create.json"
ID=$(bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).reply.sessionId)' \
  "$RUN/evidence/create.json")
stop_daemon

RESUME=$(( $(date +%s) * 1000 + 86400000 ))
sqlite3 "$DB" "UPDATE sessions SET processing_state = json_object('status','interrupted',
  'reason','restart','messageId','cut-off','resumeAt',$RESUME) WHERE id = '$ID';"
start_daemon

REF="{\"ref\":{\"adapter\":\"hyperneo\",\"id\":\"$ID\"}}"
rpc work.status "$REF" >"$RUN/evidence/status-before.json"
rpc rpc:session.get "{\"sessionId\":\"$ID\"}" >"$RUN/evidence/open.json"
rpc work.stop "$REF" >"$RUN/evidence/stop.json"
rpc neo.session.archive "$REF" >"$RUN/evidence/archive.json"
sqlite3 -readonly "$DB" "SELECT status, processing_state FROM sessions WHERE id = '$ID';" \
  >"$RUN/evidence/session-row.txt"
stop_daemon

for f in status-before stop archive; do
  echo "$f: $(tr -d '\n ' <"$RUN/evidence/$f.json" | cut -c1-300)"
done
echo "row: $(cat "$RUN/evidence/session-row.txt")"
grep -q '"stopped": true' "$RUN/evidence/stop.json" || { echo 'FAIL: stop did not report stopped'; exit 1; }
grep -q '"archived": true' "$RUN/evidence/archive.json" || { echo 'FAIL: archive refused'; exit 1; }
[[ "$(cat "$RUN/evidence/session-row.txt")" == 'archived|{"status":"interrupted"}' ]] ||
  { echo 'FAIL: session row'; exit 1; }
echo PASS
