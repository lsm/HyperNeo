#!/bin/bash
# usage: sidebar-system-repro.sh <evidence-dir>. Owns its daemon, browser and cleanup.
set -euo pipefail
OUT=${1:?evidence dir}
cd "$(dirname "$0")/../../.."
export TMPDIR=${TMPDIR:-/tmp}
RUN=$(mktemp -d "$TMPDIR/hyperneo-verify.XXXXXX")
RUN=$(cd "$RUN" && pwd -P)
PORT=$((20000 + RANDOM % 20000)); export VERIFY_MOCK_PORT=$((40000 + RANDOM % 10000))
trap '.claude/skills/verify/stop.sh "$RUN" > /dev/null; rm -rf "$RUN"' EXIT
VERIFY_NORMAL_PRIORITY=1 VERIFY_LOG_LEVEL=error .claude/skills/verify/launch.sh "$PORT" "$RUN" | tail -1
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT=$PORT
mkdir -p "$RUN/evidence" "$OUT"
for name in alpha beta delta-only hidden archived shared-a shared-b stale-a stale-b; do
  mkdir -p "$RUN/projects/$name" && git -C "$RUN/projects/$name" init -q
  bun .claude/skills/verify/rpc.ts rpc:workspace.add "{\"path\":\"$RUN/projects/$name\"}" > /dev/null
done
printf 'synthetic file\n' > "$RUN/projects/alpha/retained.txt"
printf 'synthetic file\n' > "$RUN/projects/shared-a/retained.txt"
bun .claude/skills/verify/rpc.ts rpc:session.create "{\"title\":\"Retained chat\",\"workspacePath\":\"$RUN/projects/beta\",\"config\":{\"queryMode\":\"manual\"}}" > /dev/null
python3 - "$RUN/data/daemon.db" "$RUN/projects/alpha" "$RUN/projects/beta" "$RUN/projects/delta-only" "$RUN/projects/hidden" "$RUN/projects/archived" <<'SEED'
import os,sqlite3,sys,socket
c=sqlite3.connect(sys.argv[1])
for project_id,title,path in [('synth','neo-read',sys.argv[2]),('busy','occupied',sys.argv[3]),('fail','refused',sys.argv[4]),('hidden','hidden-worker',sys.argv[5]),('archived','archived-chat',sys.argv[6])]:
    c.execute("INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES (?,?, '', '',1,1,1)", (project_id,title))
    c.execute('INSERT INTO neo_project_workspaces(alias,project_id) VALUES (?,?)', ('folder:'+socket.gethostname()+'\0'+os.path.realpath(path), project_id))
for project_id,title in [('empty','folderless'), ('remote','remote-work'), ('linked','linked-ask'), ('inbox','Inbox')]:
    c.execute("INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES (?,?, '', '',1,1,1)", (project_id,title))
c.execute('INSERT INTO neo_project_workspaces(alias,project_id) VALUES (?,?)', ('folder:elsewhere\0/synthetic/remote', 'remote'))
c.execute("INSERT INTO neo_asks(id,session_id,project_id,title,request,status,created_at,updated_at) VALUES ('open-ask','neo:synthetic','linked','Open ask','Request','open',1,1)")
root=os.path.dirname(os.path.realpath(sys.argv[2]))
for project_id,title,names in [('shared','Shared project',['shared-a','shared-b']),('stale','Stale project',['stale-a','stale-b'])]:
    c.execute('INSERT INTO workspace_projects(id,name) VALUES (?,?)',(project_id,title))
    for name in names:
        c.execute('INSERT INTO workspace_project_folders(path,project_id) VALUES (?,?)',(os.path.join(root,name),project_id))
c.execute("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata,type) VALUES ('hidden-worker','Synthetic worker',?, '2026-01-01', '2026-01-01', 'active', '{}', '{}', 'space_task_agent')", (os.path.realpath(sys.argv[5]),))
c.execute("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata,type) VALUES ('archived-chat','Archived chat',?, '2026-01-01', '2026-01-01', 'archived', '{}', '{}', 'worker')", (os.path.realpath(sys.argv[6]),))
c.execute("INSERT INTO sessions(id,title,workspace_path,created_at,last_active_at,status,config,metadata,type) VALUES ('ended-worker','Finished synthetic worker',?, '2026-01-01', '2026-01-01', 'ended', '{}', '{}', 'space_task_agent')", (os.path.realpath(sys.argv[2]),))
c.execute("CREATE TRIGGER refuse_forget BEFORE DELETE ON neo_concerns WHEN OLD.id = 'fail' BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END")
c.commit(); c.close()
SEED
CODE=$(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin" TMPDIR="$TMPDIR" \
  NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" \
  bun run packages/cli/main.ts pair --kind human |
  python3 -c "import json,sys;print(json.load(sys.stdin)['code'])")
set +e
PAIR_CODE="$CODE" VERIFY_INJECT_FAILURE="${VERIFY_INJECT_FAILURE:-}" NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  "${VERIFY_NODE:-node}" .claude/skills/verify/sidebar-system-repro.mjs "$PORT" "$RUN"
STATUS=$?
cp "$RUN"/evidence/sidebar-* "$OUT"/ 2>/dev/null
exit $STATUS
