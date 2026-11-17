#!/usr/bin/env bash
set -euo pipefail
PORT=${1:?usage: with-run.sh session-operation-names.sh port}
: "${RUN:?run under with-run.sh}"
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
mkdir -p "$RUN/workspace"
call() { bun "$HERE/rpc.ts" "$1" "$2"; }
space=$(call rpc:space.create "{\"name\":\"Session proof\",\"workspacePath\":\"$RUN/workspace\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"]["id"])')
call session.list "{\"spaceId\":\"$space\"}" > "$RUN/list.json"
call session.get "{\"spaceId\":\"$space\",\"sessionId\":\"missing\"}" > "$RUN/get.json"
call session.message.list "{\"spaceId\":\"$space\",\"sessionId\":\"missing\"}" > "$RUN/messages.json"
call session.interrupt "{\"spaceId\":\"$space\",\"sessionId\":\"missing\"}" > "$RUN/interrupt.json"
python3 - "$RUN" "$space" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); space=sys.argv[2]
r={name:json.loads((p/(name+'.json')).read_text())['reply'] for name in ('list','get','messages','interrupt')}
assert r['list']['ok'] and isinstance(r['list']['sessions'],list), r
for name in ('get','messages','interrupt'):
    assert r[name]['ok'] is False and r[name]['reason']=='session_not_found', r
print(json.dumps(r,sort_keys=True).replace(space,'<space>'))
PY
