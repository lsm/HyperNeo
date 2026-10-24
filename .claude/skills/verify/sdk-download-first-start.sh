#!/usr/bin/env bash
set -euo pipefail
BIN=${1:?usage: sdk-download-first-start.sh <compiled-hyperneo-binary> <fresh-absolute-run-dir> [port]}
RUN=${2:?usage: sdk-download-first-start.sh <compiled-hyperneo-binary> <fresh-absolute-run-dir> [port]}
PORT=${3:-9411}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 ]]
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy" >&2; exit 1; fi
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
env -i HOME="$RUN/home" PATH=/usr/bin:/bin:/usr/sbin TMPDIR="$RUN" HYPERNEO_DATA_DIR="$RUN/data" \
  "$BIN" --port "$PORT" --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 360); do
  kill -0 "$PID"
  grep -qE '\[SDK\] Claude Code binary (ready|unavailable)' "$RUN/daemon.log" && break
  sleep 0.5
done
sleep 3
cp "$RUN/daemon.log" "$RUN/evidence/daemon.log"
grep -E '^\[SDK\]' "$RUN/daemon.log"
grep -q '\[SDK\] Claude Code binary ready: ' "$RUN/daemon.log" || { echo 'FAIL: binary was not downloaded'; exit 1; }
worst=$(grep -oE 'Event loop blocked for [0-9]+ms' "$RUN/daemon.log" | grep -oE '[0-9]+' | sort -n | tail -1)
echo "worst event-loop block: ${worst:-none}ms"
[[ -z "$worst" ]] || { echo 'FAIL: event loop blocked during first start'; exit 1; }
echo 'PASS: SDK binary downloaded with no event-loop block'
