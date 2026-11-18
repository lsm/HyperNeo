#!/usr/bin/env bash
set -euo pipefail
PORT=${1:?usage: with-run.sh goal-operation-names.sh port}
: "${RUN:?run under with-run.sh}"
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
mkdir -p "$RUN/workspace"
call() { bun "$HERE/rpc.ts" "$1" "$2"; }
space=$(call rpc:space.create "{\"name\":\"Goal proof\",\"workspacePath\":\"$RUN/workspace\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"]["id"])')
call goal.get "{\"spaceId\":\"$space\",\"goalId\":\"missing\"}" > "$RUN/missing.json"
call goal.create "{\"spaceId\":\"$space\",\"title\":\"Proof goal\"}" > "$RUN/create.json"
python3 - "$RUN" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
missing=json.loads((p/'missing.json').read_text())['reply']
created=json.loads((p/'create.json').read_text())['reply']
assert missing['accepted'] is False and missing['reason'] == 'goal_not_found', missing
assert created['accepted'] is True and created['goal']['title'] == 'Proof goal', created
print(json.dumps({'missing':missing, 'created':{'accepted':created['accepted'], 'title':created['goal']['title']}}, sort_keys=True))
PY
