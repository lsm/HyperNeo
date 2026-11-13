#!/usr/bin/env bash
# Phone navigation has no bottom tab bar and reaches Chats and Settings.
# Usage: bottom-nav.sh <absolute-evidence-directory> (never uses 8399).
set -euo pipefail
OUT=${1:?usage: bottom-nav.sh <absolute-evidence-directory>}
[[ "$OUT" = /* ]] || { echo 'Evidence directory must be absolute'; exit 64; }
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$ROOT"
[[ $(uname) != Darwin ]] || bash .claude/skills/verify/resource-check.sh
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")
job=''
cleanup() {
  if [[ -n "$job" ]]; then kill -TERM "$job" 2>/dev/null || true; wait "$job" 2>/dev/null || true; fi
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
[[ "$PORT" != 8399 && "$MOCK_PORT" != 8399 ]]
VERIFY_MOCK_PORT="$MOCK_PORT" VERIFY_NORMAL_PRIORITY=1 bash .claude/skills/verify/launch.sh "$PORT" "$RUN" &
job=$!; wait "$job"; job=''
ENVV=(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT")
SESSION=$("${ENVV[@]}" bun .claude/skills/verify/rpc.ts 'rpc:session.create' '{"title":"Phone navigation proof"}' | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const r=JSON.parse(s).reply;if(!r.sessionId)throw Error(JSON.stringify(r));console.log(r.sessionId)})')
mkdir -p "$RUN/workspace/space"
SPACE=$("${ENVV[@]}" bun .claude/skills/verify/rpc.ts rpc:space.create "{\"name\":\"Phone nav Space\",\"workspacePath\":\"$RUN/workspace/space\"}" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const r=JSON.parse(s).reply;if(!r.slug)throw Error(JSON.stringify(r));console.log(r.slug)})')
VERIFY_PORT="$PORT" VERIFY_SESSION="$SESSION" VERIFY_SPACE="$SPACE" node .claude/skills/verify/bottom-nav.mjs "$PORT" "$OUT" "$RUN" &
job=$!; wait "$job"; job=''
