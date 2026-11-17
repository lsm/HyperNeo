#!/usr/bin/env bash
set -euo pipefail
PORT=${1:?usage: with-run.sh workflow-operation-names.sh port}
: "${RUN:?run under with-run.sh}"
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
mkdir -p "$RUN/workspace"
call() { bun "$HERE/rpc.ts" "$1" "$2"; }
space=$(call rpc:space.create "{\"name\":\"Workflow proof\",\"workspacePath\":\"$RUN/workspace\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"]["id"])')
call workflow.list "{\"spaceId\":\"$space\"}" > "$RUN/list.json"
call workflow.get "{\"spaceId\":\"$space\",\"workflowId\":\"missing\"}" > "$RUN/missing-workflow.json"
call workflow.run.get "{\"spaceId\":\"$space\",\"runId\":\"missing\"}" > "$RUN/missing-run.json"
python3 - "$RUN" "$space" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); space=sys.argv[2]
replies={name:json.loads((p/(name+'.json')).read_text())['reply'] for name in ('list','missing-workflow','missing-run')}
assert replies['missing-workflow']=='workflow_not_found', replies
assert replies['missing-run']=='run_not_found', replies
assert isinstance(replies['list']['workflows'],list), replies
for workflow in replies['list']['workflows']:
    for field in ('id', 'createdAt', 'updatedAt'):
        workflow.pop(field)
print(json.dumps(replies,sort_keys=True).replace(space,'<space>'))
PY
