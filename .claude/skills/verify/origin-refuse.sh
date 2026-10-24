#!/bin/bash
# #7975: a cross-site Origin is refused on WebSocket upgrades and mutating HTTP at every
# front door; same-origin, loopback-origin, Origin-less and allowed-host requests still
# connect. Usage: origin-refuse.sh <port> [door...] (doors: daemon prod dev embedded;
# never 8399). Needs the web build; writes the gitignored embedded-asset modules.
set -euo pipefail
PORT=${1:?usage: origin-refuse.sh <port> [door...]}
shift
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
[ $# -eq 0 ] && set -- daemon prod dev embedded
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/origin-refuse.XXXXXX")
cd "$ROOT"
bun run scripts/generate-embedded-assets.ts > /dev/null
for door in "$@"; do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
  mkdir -p "$RUN/$door/home" "$RUN/$door/data"
  env -i HOME="$RUN/$door/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
    TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/$door/data" \
    bun .claude/skills/verify/origin-refuse-door.ts "$door" "$PORT" "$RUN/$door/data/daemon.db" \
    < /dev/null > "$RUN/$door/daemon.log" 2>&1 &
  PID=$!
  for _ in $(seq 1 120); do
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
    kill -0 $PID 2>/dev/null || { echo "$door exited"; tail -20 "$RUN/$door/daemon.log"; exit 1; }
    sleep 1
  done
  sleep 1
  echo "== $door"
  bun .claude/skills/verify/origin-refuse-probe.ts "$PORT"
  kill $PID; wait $PID 2>/dev/null || true
  for _ in $(seq 1 20); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.5; done
done
echo "run dir: $RUN"
