#!/bin/bash
set -euo pipefail
RUN=${1:?usage: seed-ledger.sh <run-dir>}
DB="$RUN/data/daemon.db"
ROOT=$(sqlite3 -readonly "$DB" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
[ -n "$ROOT" ] || { echo "open root Neo first: rpc.ts neo.open '{}'"; exit 1; }
NOW_MS=$(($(date +%s) * 1000))
ROWS=""
for n in $(seq 100 219); do
  ROWS="$ROWS INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, read_at)
    VALUES ('verify-test/demo', $n, 'Older PR $n', 'b$n', 'h$n', 'waiting_review', $((NOW_MS - 1000000 + n)), $NOW_MS);"
done
sqlite3 "$DB" "INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at)
  VALUES ('ask-ledger', '$ROOT', 'Ship the loader fix', 'Ship the loader fix', 'open', $NOW_MS, $NOW_MS);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, state, created_at, updated_at, started_at)
  VALUES ('todo-ledger', 'ask-ledger', 1, 'Fix the loader', 'PR merged', 'doing', $NOW_MS, $NOW_MS, $NOW_MS);
INSERT INTO pack_coding_pr_claims (todo_id, url, claim, claimed_at)
  VALUES ('todo-ledger', 'https://github.com/verify-test/demo/pull/8', 'named', $NOW_MS);
INSERT INTO pack_coding_pr_ledger (repo, number, title, branch, head, state, state_since, owner, read_at)
  VALUES ('verify-test/demo', 8, 'Fix the loader', 'fix-loader', 'aaa111', 'approved_green', $NOW_MS,
    '{\"adapter\":\"hyperneo\",\"id\":\"worker-1\"}', $NOW_MS);
$ROWS"
echo "seeded todo-ledger claiming verify-test/demo#8, newer than 120 other open PRs"
