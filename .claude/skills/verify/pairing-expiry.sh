#!/bin/bash
set -euo pipefail
PORT=${1:?usage: pairing-expiry.sh <port>}
: "${RUN:?run through with-run.sh}"
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
python3 - <<'PY'
import json, os, pathlib, sqlite3, subprocess, time, urllib.request, urllib.error
run = pathlib.Path(os.environ['RUN'])
reply = json.loads(subprocess.check_output(['bun', '.claude/skills/verify/rpc.ts', 'device.pair.create', '{"kind":"human","confirm":"two-way"}']))['reply']
assert reply['ok'], 'pair creation refused'
def pair():
    req = urllib.request.Request('http://127.0.0.1:' + os.environ['VERIFY_PORT'] + '/pair', data=json.dumps({'code':reply['code'], 'name':'Expiry phone', 'requestId':'00112233445566778899aabbccddeeff'}).encode(), headers={'content-type':'application/json'})
    try:
        response = urllib.request.urlopen(req)
    except urllib.error.HTTPError as error:
        response = error
    return response.status, json.load(response)
assert pair() == (403, {'error':'awaiting_approval'})
with sqlite3.connect(run / 'data/daemon.db') as db:
    db.execute('UPDATE pairing_codes SET expires_at = ? WHERE id = ?', (int(time.time() * 1000) + 100, reply['codeId']))
status, body = pair()
assert (status, body) == (401, {'error':'code_expired'}), (status, body)
evidence = 'PASS: held POST /pair returned 401 code_expired at expiry; no credential issued.\n'
(run / 'evidence/pairing-expiry.txt').write_text(evidence)
print(evidence, end='')
PY
