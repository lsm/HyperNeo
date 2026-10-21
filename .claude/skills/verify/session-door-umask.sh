#!/bin/bash
set -euo pipefail
PORT=${1:?usage: session-door-umask.sh <port> <fresh-run-directory>}
RUN=${2:?usage: session-door-umask.sh <port> <fresh-run-directory>}
[ "$PORT" = 8399 ] && { echo 'refusing 8399'; exit 1; }
[ -e "$RUN" ] && { echo 'run directory must be fresh'; exit 1; }
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is busy"; exit 1
fi
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
RUN=$(cd "$RUN" && pwd)
cd "$ROOT"
umask 022
env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  VERIFY_SESSION_DOOR_OBSERVATION="$RUN/evidence/creation.json" \
  bun --preload "$ROOT/.claude/skills/verify/session-door-observe.ts" packages/cli/main.ts \
  --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 120); do
  [ -f "$RUN/evidence/creation.json" ] && [ -S "$RUN/data/session-door.sock" ] && break
  kill -0 "$PID" 2>/dev/null || { cat "$RUN/daemon.log"; exit 1; }
  sleep 0.25
done
curl --fail --silent --show-error --unix-socket "$RUN/data/session-door.sock" \
  -H 'content-type: application/json' -d '{"sender":"verify-s10","name":"system.build","input":{}}' \
  http://localhost/ > "$RUN/evidence/build.json"
curl --silent --show-error --unix-socket "$RUN/data/session-door.sock" \
  -H 'content-type: application/json' -d '{"sender":"verify-s10","name":"device.enforce.off","input":{}}' \
  http://localhost/ > "$RUN/evidence/refused.json"
python3 - "$RUN" <<'PY'
import json, pathlib, stat, sys
run = pathlib.Path(sys.argv[1])
creation = json.loads((run / 'evidence/creation.json').read_text())
build = json.loads((run / 'evidence/build.json').read_text())
refused = json.loads((run / 'evidence/refused.json').read_text())
result = {**creation, 'finalMode': stat.S_IMODE((run / 'data/session-door.sock').stat().st_mode),
          'buildHealth': build['value']['health'], 'outsideAllowlist': refused['error']}
(run / 'evidence/result.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
assert creation['modeBeforeChmod'] == 0o600, 'socket was exposed before chmod'
assert creation['umask'] == 0o022, 'daemon ambient umask was not restored'
assert result['finalMode'] == 0o600
assert result['buildHealth'] == 'ok'
assert result['outsideAllowlist'].startswith('not_allowed:')
PY
echo "evidence: $RUN/evidence (daemon stops on exit)"
