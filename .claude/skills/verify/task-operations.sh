#!/bin/bash
set -euo pipefail
PORT=${1:?usage: task-operations.sh port}
[ "$PORT" != 8399 ] || exit 1
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo 'port busy' >&2; exit 1; fi
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/task-ops.XXXXXX")
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
rpc task.create '{"title":"proof task"}' > "$RUN/create.json"
TASK_ID=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["reply"]; assert r["title"] == "proof task"; print(r["id"])' "$RUN/create.json")
rpc task.get "{\"taskId\":\"$TASK_ID\"}" > "$RUN/get.json"
rpc task.list '{}' > "$RUN/list.json"
rpc task.update "{\"taskId\":\"$TASK_ID\",\"title\":\"updated task\"}" > "$RUN/update.json"
rpc task.transition "{\"taskId\":\"$TASK_ID\",\"status\":\"in_progress\"}" > "$RUN/transition.json"
rpc task.get "{\"taskId\":\"$TASK_ID\"}" > "$RUN/final.json"
rpc task.get '{"taskId":"missing-task"}' > "$RUN/missing-get.json"
rpc task.update '{"taskId":"missing-task","title":"absent"}' > "$RUN/missing-update.json"
rpc task.transition '{"taskId":"missing-task","status":"in_progress"}' > "$RUN/missing-transition.json"
python3 - "$RUN" "$TASK_ID" <<'PY'
import json, sys
from pathlib import Path
run, task_id = Path(sys.argv[1]), sys.argv[2]
names = ['create', 'get', 'list', 'update', 'transition', 'final', 'missing-get', 'missing-update', 'missing-transition']
replies = {name: json.loads((run / (name + '.json')).read_text())['reply'] for name in names}
assert replies['get']['id'] == task_id
assert replies['list']['total'] == 1 and replies['list']['tasks'][0]['id'] == task_id
assert replies['update']['title'] == 'updated task'
assert replies['transition']['status'] == 'in_progress'
assert replies['final']['title'] == 'updated task' and replies['final']['status'] == 'in_progress'
assert replies['missing-get'] is None and replies['missing-update'] is None and replies['missing-transition'] is None
def normalize(value):
    if isinstance(value, dict):
        return {k: normalize(v) for k, v in value.items() if k not in ('createdAt', 'updatedAt', 'startedAt', 'completedAt', 'archivedAt')}
    if isinstance(value, list): return [normalize(v) for v in value]
    return '<task-id>' if value == task_id else value
print(json.dumps(normalize(replies), sort_keys=True, indent=2))
print('task operations: RPC assertions passed')
PY
