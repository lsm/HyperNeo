#!/usr/bin/env bash
# The human turns desktop control on for one todo from the Neo page.
# Usage: desktop-control-toggle.sh <absolute-evidence-directory> (never uses 8399).
set -euo pipefail
OUT=${1:?usage: desktop-control-toggle.sh <absolute-evidence-directory>}
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
[[ "$PORT" != 8399 && "$PORT" != 8499 && "$MOCK_PORT" != 8399 && "$MOCK_PORT" != 8499 ]]
VERIFY_MOCK_PORT="$MOCK_PORT" VERIFY_NORMAL_PRIORITY=1 bash .claude/skills/verify/launch.sh "$PORT" "$RUN" &
job=$!; wait "$job"; job=''
ENVV=(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT")
bun .claude/skills/verify/desktop-control-toggle-seed.ts "$RUN" | tee "$OUT/seed.json"
"${ENVV[@]}" bun .claude/skills/verify/rpc.ts desktop.status '{}' | tee "$OUT/status-before.json"
node .claude/skills/verify/desktop-control-toggle-web.mjs "$PORT" "$OUT" "$RUN" &
job=$!; wait "$job"; job=''
"${ENVV[@]}" bun .claude/skills/verify/rpc.ts desktop.status '{}' | tee "$OUT/status-after.json"
sqlite3 -readonly "$RUN/data/daemon.db" "SELECT id, named FROM neo_todos ORDER BY position" | tee "$OUT/named.txt"
