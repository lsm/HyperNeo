#!/bin/bash
# usage: sidebar-project-new-session.sh <evidence-dir>. Owns its daemon, browser and cleanup.
set -uo pipefail
OUT=${1:?evidence dir}
cd "$(dirname "$0")/../../.."
export TMPDIR=${TMPDIR:-/private/tmp}
RUN=$(mktemp -d "$TMPDIR/hyperneo-verify.XXXXXX")
PORT=$((20000 + RANDOM % 20000)); export VERIFY_MOCK_PORT=$((40000 + RANDOM % 10000))
trap '.claude/skills/verify/stop.sh "$RUN" > /dev/null; rm -rf "$RUN"' EXIT
VERIFY_NORMAL_PRIORITY=1 VERIFY_LOG_LEVEL=error .claude/skills/verify/launch.sh "$PORT" "$RUN" | tail -1
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT
mkdir -p "$RUN/evidence" "$OUT"
mkdir -p "$RUN/projects/assets-light" "$RUN/projects/assets-dark"
mkdir -p "$RUN/projects/assets-light-retarget" "$RUN/projects/assets-dark-retarget"
mkdir -p "$RUN/projects/gamma-light" "$RUN/projects/gamma-dark"
mkdir -p "$RUN/projects/gamma-light-assets" "$RUN/projects/gamma-dark-assets"
mkdir -p "$RUN/projects/delta-only"
mkdir -p "$RUN/projects/delta-only-assets"
for name in alpha beta delta-only; do
  mkdir -p "$RUN/projects/$name" && git -C "$RUN/projects/$name" init -q
  bun .claude/skills/verify/rpc.ts rpc:workspace.add "{\"path\":\"$RUN/projects/$name\"}" > /dev/null
done
python3 - "$RUN/data/daemon.db" "$RUN/projects/alpha" <<'SEED'
import sqlite3,sys,socket
c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES ('synth','neo-read','','',1,1,1)"); c.execute('INSERT INTO neo_project_workspaces(alias,project_id) VALUES (?,?)', ('folder:'+socket.gethostname()+'\0'+sys.argv[2], 'synth')); c.commit(); c.close()
SEED
CODE=$(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" TMPDIR="$TMPDIR" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" \
  bun run packages/cli/main.ts pair --kind human |
  python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
VERIFY_CREDENTIAL=$(cd packages/daemon && bun -e "import {readLocalCredential} from \"./src/lib/pairing/local-credential.ts\"; console.log(readLocalCredential())")
export VERIFY_CREDENTIAL
PAIR_CODE="$CODE" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  "${VERIFY_NODE:-node}" .claude/skills/verify/sidebar-system-repro.mjs "$PORT" "$RUN"
STATUS=$?
cp "$RUN"/evidence/sidebar-* "$OUT"/ 2>/dev/null
cp "$RUN/evidence/retarget-project.txt" "$OUT"/ 2>/dev/null
exit $STATUS
