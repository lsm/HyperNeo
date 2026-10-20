#!/bin/bash
set -euo pipefail
RUN=${1:?usage: archive-guard-check.sh <run-dir>}
DB="$RUN/data/daemon.db"
RPC="$(dirname "$0")/rpc.ts"
: "${VERIFY_PORT:?set VERIFY_PORT}"
ROOT=$(sqlite3 -readonly "$DB" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
[ -n "$ROOT" ] || { echo "open root Neo first: rpc.ts neo.open '{}'"; exit 1; }
NOW_MS=$(($(date +%s) * 1000))
REF='{"adapter":"hyperneo","id":"verify-archive"}'
sqlite3 "$DB" "INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
  VALUES ('ask-archive', '$ROOT', 'Keep the session', 'Keep the session', 'open', $NOW_MS, $NOW_MS);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at, started_at)
  VALUES ('todo-archive', 'ask-archive', 1, 'Work in the session', 'Work done', 'doing', $NOW_MS, $NOW_MS, $NOW_MS);
INSERT INTO neo_todo_sessions (todo_id, target, ref)
  VALUES ('todo-archive', '{\"verb\":\"adopt\",\"ref\":$REF}', '$REF');"
bun "$RPC" neo.session.archive "{\"ref\":$REF}" > "$RUN/evidence/archive-doing.json"
sqlite3 "$DB" "UPDATE neo_todos SET state = 'done', finished_at = $NOW_MS WHERE id = 'todo-archive'"
bun "$RPC" neo.session.archive "{\"ref\":$REF}" > "$RUN/evidence/archive-done.json"
echo "while doing:"; cat "$RUN/evidence/archive-doing.json"
echo "after done:"; cat "$RUN/evidence/archive-done.json"
