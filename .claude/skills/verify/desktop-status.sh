#!/usr/bin/env bash
# desktop.status over RPC before and after desktop.stop, with stand-in driver and app.
# Usage: desktop-status.sh <absolute-evidence-directory> (never uses 8399).
set -euo pipefail
OUT=${1:?usage: desktop-status.sh <absolute-evidence-directory>}
[[ "$OUT" = /* ]] || { echo 'Evidence directory must be absolute'; exit 64; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
[[ $(uname) != Darwin ]] || bash .claude/skills/verify/resource-check.sh
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")
job='' app='' driver=''
cleanup() {
  for pid in "$job" "$app" "$driver"; do
    if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  if bash .claude/skills/verify/stop.sh "$RUN" && cp "$RUN/daemon.log" "$RUN/mock-api.log" "$OUT/"; then
    rm -rf "$RUN"
  else
    echo "Retained unsaved run at $RUN" >&2
    return 1
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ports=$(node -e 'const net=require("node:net"); const servers=[net.createServer(),net.createServer()]; Promise.all(servers.map(s=>new Promise(r=>s.listen(0,"127.0.0.1",r)))).then(()=>{console.log(servers.map(s=>s.address().port).join(" "));servers.forEach(s=>s.close())})')
read -r PORT MOCK_PORT <<< "$ports"
[[ "$PORT" != 8399 && "$PORT" != 8499 && "$MOCK_PORT" != 8399 && "$MOCK_PORT" != 8499 ]]
VERIFY_MOCK_PORT="$MOCK_PORT" VERIFY_NORMAL_PRIORITY=1 bash .claude/skills/verify/launch.sh "$PORT" "$RUN" &
job=$!; wait "$job"; job=''
ENVV=(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT")
SESSION=$("${ENVV[@]}" bun .claude/skills/verify/rpc.ts 'rpc:session.create' '{"title":"Desktop status proof"}' | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const r=JSON.parse(s).reply;if(!r.sessionId)throw Error(JSON.stringify(r));console.log(r.sessionId)})')
sleep 900 &
driver=$!
bun .claude/skills/verify/desktop-takeover-seed.ts "$RUN" "$SESSION" "$driver" | tee "$OUT/seed.json"
node -e 'require("node:net").createServer(c=>c.on("data",()=>c.end("{\"ok\":true,\"result\":{\"state\":\"stopped\"}}\n"))).listen(process.argv[1])' "$RUN/data/desktop/control.sock" &
app=$!
for _ in $(seq 50); do [[ -S "$RUN/data/desktop/control.sock" ]] && break; sleep 0.1; done
"${ENVV[@]}" bun .claude/skills/verify/rpc.ts desktop.status "{\"worker\":\"$SESSION\"}" | tee "$OUT/status-before.json"
"${ENVV[@]}" bun .claude/skills/verify/rpc.ts desktop.status '{}' | tee "$OUT/status-list.json"
"${ENVV[@]}" bun .claude/skills/verify/rpc.ts desktop.stop "{\"worker\":\"$SESSION\"}" | tee "$OUT/stop.json"
"${ENVV[@]}" bun .claude/skills/verify/rpc.ts desktop.status "{\"worker\":\"$SESSION\"}" | tee "$OUT/status-after.json"
if kill -0 "$driver" 2>/dev/null; then echo "driver $driver still alive" | tee "$OUT/driver.txt"; exit 1; fi
rc=0; wait "$driver" 2>/dev/null || rc=$?
echo "driver $driver exit=$rc (143 = SIGTERM)" | tee "$OUT/driver.txt"
driver=''
ls -l "$RUN/data/desktop/workers/$SESSION" | tee "$OUT/worker-dir.txt"
grep -q '"state": "running"' "$OUT/status-before.json"
grep -q '"state": "stopped"' "$OUT/status-after.json"
echo 'desktop status journey: PASS'
