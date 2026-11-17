#!/usr/bin/env bash
set -euo pipefail
PORT=${1:?usage: with-run.sh evolution-operation-names.sh port}
: "${RUN:?run under with-run.sh}"
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
export VERIFY_PORT="$PORT" HYPERNEO_DATA_DIR="$RUN/data"
mkdir -p "$RUN/workspace"
call() { bun "$HERE/rpc.ts" "$1" "$2"; }
space=$(call rpc:space.create "{\"name\":\"Evolution proof\",\"workspacePath\":\"$RUN/workspace\"}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reply"]["id"])')
call evolution.scope.list "{\"spaceId\":\"$space\"}" > "$RUN/empty.json"
call evolution.scope.get "{\"spaceId\":\"$space\",\"scopeId\":\"missing\"}" > "$RUN/missing-get.json"
call evolution.scope.update "{\"spaceId\":\"$space\",\"scopeId\":\"missing\",\"name\":\"Changed\"}" > "$RUN/missing-update.json"
call evolution.scope.create "{\"spaceId\":\"$space\",\"kind\":\"custom\",\"name\":\"Proof scope\",\"objective\":\"Compare replies\"}" > "$RUN/create.json"
call evolution.scope.list "{\"spaceId\":\"$space\"}" > "$RUN/list.json"
python3 - "$RUN" "$space" <<'PY'
import json,sys
from pathlib import Path
p=Path(sys.argv[1]); space=sys.argv[2]
r={name:json.loads((p/(name+'.json')).read_text())['reply'] for name in ('empty','missing-get','missing-update','create','list')}
assert r['empty']['accepted'] and not r['empty']['scopes'], r
for name in ('missing-get','missing-update'):
    assert r[name]['accepted'] is False and r[name]['reason']=='scope_not_found', r
assert r['create']['accepted'] and r['create']['scope']['name']=='Proof scope', r
assert len(r['list']['scopes'])==1, r
scope=r['create']['scope']['id']
def normalize(value):
    if isinstance(value,dict): return {k:normalize(v) for k,v in value.items() if k not in ('createdAt','updatedAt')}
    if isinstance(value,list): return [normalize(v) for v in value]
    if isinstance(value,str): return value.replace(space,'<space>').replace(scope,'<scope>')
    return value
print(json.dumps(normalize(r),sort_keys=True))
PY
