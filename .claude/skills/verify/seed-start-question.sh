#!/bin/bash
set -euo pipefail
RUN=${1:?run dir}
DB="$RUN/data/daemon.db"
PR=https://github.com/verify-test/demo/pull/8
ROOT=$(sqlite3 -readonly "$DB" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
NOW_MS=$(($(date +%s) * 1000))
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$RUN/pr.json" <<JSON
{"url":"$PR","number":8,"state":"MERGED","createdAt":"$NOW","mergedAt":"$NOW","headRefOid":"aaa111","reviews":[],"statusCheckRollup":[],"title":"Demo"}
JSON
CHECK="{\"pack\":\"coding\",\"kind\":\"pr_merged\",\"params\":{\"urls\":[\"$PR\"]}}"
sqlite3 "$DB" "INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
  VALUES ('ask-prune', '$ROOT', 'Build the design', 'Build the design', 'open', $NOW_MS, $NOW_MS);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, instruction, state, blocked_by, created_at, updated_at)
  VALUES ('todo-a', 'ask-prune', 1, 'Merge #8', '#8 merged', '$CHECK', 'Merge it', 'blocked', 'question', $NOW_MS, $NOW_MS),
         ('todo-b', 'ask-prune', 2, 'Web', 'Merged', NULL, 'Build it', 'blocked', 'question', $NOW_MS, $NOW_MS);
INSERT INTO neo_questions (id, ask_id, text, kind, start_todos, created_at)
  VALUES ('q-start', 'ask-prune', 'Start these 2?', 'start', '[\"todo-a\",\"todo-b\"]', $NOW_MS);"
echo "seeded ask-prune: todo-a (check met, not started), todo-b (no check), q-start lists both"
