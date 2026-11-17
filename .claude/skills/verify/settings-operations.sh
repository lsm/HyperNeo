#!/bin/bash
set -euo pipefail
PORT=${1:?usage: settings-operations.sh port}
[ "$PORT" != 8399 ] || exit 1
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo 'port busy' >&2; exit 1; fi
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/settings-ops.XXXXXX")
mkdir -p "$RUN/home" "$RUN/data"
ENV=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_SPACE=on HYPERNEO_DATA_DIR="$RUN/data")
cd "$ROOT"
"${ENV[@]}" bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" >"$RUN/daemon.log" 2>&1 &
PID=$!
finish() {
  local status=$? daemon=0
  trap - EXIT
  kill -TERM "$PID" 2>/dev/null || true
  for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$PID" 2>/dev/null; then echo "daemon did not stop; retained $RUN" >&2; exit 1; fi
  wait "$PID" || daemon=$?
  if { [ "$daemon" -ne 0 ] && [ "$daemon" -ne 143 ]; } || ! grep -q 'Graceful shutdown complete' "$RUN/daemon.log"; then status=1; fi
  if [ "$status" -eq 0 ]; then rm -rf "$RUN"; else echo "retained $RUN" >&2; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ready=
for _ in $(seq 1 120); do
  code=$(curl -s --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [ "${code:-000}" != 000 ] && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo 'daemon not ready' >&2; exit 1; }
rpc() { "${ENV[@]}" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"; }
rpc settings.model.get '{}' > "$RUN/get.json"
rpc settings.model.set '{"model":"unavailable-proof-model"}' > "$RUN/set.json"
rpc settings.provider.usage '{"providerId":"missing-proof-provider"}' > "$RUN/usage.json"
python3 - "$RUN" <<'PYCODE'
import json, sys
from pathlib import Path
run = Path(sys.argv[1])
replies = {name: json.loads((run / (name + '.json')).read_text())['reply'] for name in ('get', 'set', 'usage')}
assert set(replies['get']) == {'model', 'provider', 'availableModels'}
assert replies['set']['ok'] is False and replies['set']['reason'] == 'model_unavailable'
assert replies['usage'] == {'supported': False, 'provider': 'missing-proof-provider', 'reason': 'not_supported'}
print(json.dumps(replies, sort_keys=True, indent=2))
print('settings operations: RPC assertions passed; missing provider exact match')
PYCODE
