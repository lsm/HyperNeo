#!/bin/bash
set -euo pipefail
RUN=${1:?usage: seed-todo.sh <run-dir>}
DB="$RUN/data/daemon.db"
PR=https://github.com/verify-test/demo/pull/8
ROOT=$(sqlite3 -readonly "$DB" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
[ -n "$ROOT" ] || { echo "open root Neo first: rpc.ts neo.open '{}'"; exit 1; }
NOW_MS=$(($(date +%s) * 1000))
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$RUN/pr.json" <<JSON
{"url":"$PR","number":8,"state":"MERGED","createdAt":"$NOW","mergedAt":"$NOW","headRefOid":"aaa111","reviews":[],"statusCheckRollup":[],"title":"Demo"}
JSON
sqlite3 "$DB" "INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
  VALUES ('ask-verify', '$ROOT', 'Fix the demo loader', 'Fix the demo loader', 'open', $NOW_MS, $NOW_MS);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, state, report, created_at, updated_at, started_at)
  VALUES ('todo-verify', 'ask-verify', 1, 'Fix the loader', 'PR merged',
    '{\"pack\":\"coding\",\"kind\":\"pr_merged\",\"params\":{}}', 'doing', 'Opened $PR for the loader fix.',
    $NOW_MS, $NOW_MS, $NOW_MS);"
echo "seeded todo-verify for $ROOT; its PR reads as merged"
