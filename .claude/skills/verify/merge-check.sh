#!/bin/bash
set -euo pipefail
RUN=${1:?usage: merge-check.sh <run-dir>}
DB="$RUN/data/daemon.db"
ROOT=$(sqlite3 -readonly "$DB" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
[ -n "$ROOT" ] || { echo "open root Neo first: rpc.ts neo.open '{}'"; exit 1; }
NOW_MS=$(($(date +%s) * 1000))
sqlite3 "$DB" "INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at)
  VALUES ('project:web', 'Web', '', '', 1, $((NOW_MS - 60000)), $((NOW_MS - 60000))),
    ('project:web-copy', 'Web', '', '', 1, $NOW_MS, $NOW_MS);
INSERT INTO neo_project_workspaces (alias, project_id)
  VALUES ('repository:github.com/verify-test/web', 'project:web'),
    ('repo:verify-test/web' || char(0) || 'copy', 'project:web-copy');
INSERT INTO neo_asks (id, session_id, project_id, title, request, status, repo, created_at, updated_at)
  VALUES ('ask-merge', '$ROOT', 'project:web-copy', 'Tidy the header', 'Tidy the header', 'done',
    'github.com/verify-test/web', $NOW_MS, $NOW_MS);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, repo, created_at, updated_at)
  VALUES ('todo-merge', 'ask-merge', 1, 'Tidy the header', 'Header tidied', 'done',
    'github.com/verify-test/other', $NOW_MS, $NOW_MS);"
VERIFY_PORT=${VERIFY_PORT:?set VERIFY_PORT} bun "$(dirname "$0")/rpc.ts" neo.projects.reorganize '{"apply":true}' \
  > "$RUN/evidence/merge-reorganize.json"
sqlite3 -readonly "$DB" "SELECT 'merge', source_id, target_id FROM neo_project_merges;
SELECT 'ask', id, project_id, repo FROM neo_asks WHERE id = 'ask-merge';
SELECT 'todo', id, repo FROM neo_todos WHERE id = 'todo-merge';"
