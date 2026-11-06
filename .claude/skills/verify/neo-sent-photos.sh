#!/usr/bin/env bash
set -euo pipefail
OUT=${1:?usage: neo-sent-photos.sh <absolute-evidence-directory> [browser-helper]}
WEB=${2:-.claude/skills/verify/neo-sent-photos-web.mjs}
[[ "$OUT" = /* ]] || { echo 'Evidence directory must be absolute'; exit 64; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")
job=''
cleanup() {
  if [[ -n "$job" ]]; then kill -TERM "$job" 2>/dev/null || true; wait "$job" 2>/dev/null || true; fi
  if bash .claude/skills/verify/stop.sh "$RUN" &&
    cp "$RUN/daemon.log" "$RUN/mock-api.log" "$OUT/"; then
    rm -rf "$RUN"
  else
    echo "Retained unsaved run at $RUN" >&2
    return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ $(uname) != Darwin ]] || bash .claude/skills/verify/resource-check.sh
ports=$(node -e 'const net=require("node:net"); const servers=[net.createServer(),net.createServer()]; Promise.all(servers.map(s=>new Promise(r=>s.listen(0,"127.0.0.1",r)))).then(()=>{console.log(servers.map(s=>s.address().port).join(" "));servers.forEach(s=>s.close())})')
read -r PORT MOCK_PORT <<< "$ports"
[[ "$PORT" != 8399 && "$PORT" != 8499 && "$MOCK_PORT" != 8399 && "$MOCK_PORT" != 8499 ]]
VERIFY_MOCK_PORT="$MOCK_PORT" VERIFY_NORMAL_PRIORITY=1 bash .claude/skills/verify/launch.sh "$PORT" "$RUN" &
job=$!; wait "$job"; job=''
PAIR_CODE=$(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts device.pair.create '{"kind":"human","name":"Synthetic browser"}' | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const r=JSON.parse(s).reply;if(!r.ok)throw Error(JSON.stringify(r));console.log(r.code)})')
PAIR_CODE="$PAIR_CODE" node "$WEB" "$PORT" "$OUT" &
job=$!; wait "$job"; job=''
