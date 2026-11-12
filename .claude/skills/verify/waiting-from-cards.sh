#!/bin/bash
# waiting-from-cards.sh — a parent ask's card covers a todo of its child ask:
# the list, the counts and the runner agree that the todo waits on the human,
# and it starts once the card is answered.
#
# Usage: .claude/skills/verify/with-run.sh bash -c \
#   '.claude/skills/verify/waiting-from-cards.sh "$RUN" 9367'
set -euo pipefail
RUN=${1:?usage: waiting-from-cards.sh <run-dir> [port]}
PORT=${2:-9367}
HERE=$(cd "$(dirname "$0")" && pwd)
DB="$RUN/data/daemon.db"
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap '"$HERE/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT

"$HERE/launch.sh" "$PORT" "$RUN"
bun "$HERE/rpc.ts" neo.open '{}' >/dev/null
ROOT=$(sqlite3 -readonly "$DB" "SELECT session_id FROM neo_session_bindings WHERE kind = 'neo' AND concern_id IS NULL")
"$HERE/stop.sh" "$RUN"

NOW=$(($(date +%s) * 1000))
TARGET="{\"verb\":\"start\",\"adapter\":\"hyperneo\",\"place\":{\"machine\":\"local\",\"name\":\"Fixture\",\"folder\":\"$RUN/home\"}}"
sqlite3 "$DB" "
INSERT INTO neo_asks (id, session_id, title, request, status, parent_id, created_at, updated_at) VALUES
  ('ask-parent', '$ROOT', 'Parent', 'Parent', 'open', NULL, $NOW, $NOW),
  ('ask-child', '$ROOT', 'Child', 'Child', 'open', 'ask-parent', $NOW, $NOW),
  ('ask-free', '$ROOT', 'Free', 'Free', 'open', NULL, $NOW, $NOW);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, approved_at, created_at, updated_at) VALUES
  ('covered', 'ask-child', 1, 'Covered step', 'Seen', 'Do it', 'todo', $NOW, $NOW, $NOW),
  ('free', 'ask-free', 1, 'Free step', 'Seen', 'Do it', 'todo', $NOW, $NOW, $NOW);
INSERT INTO neo_todo_sessions (todo_id, target) VALUES
  ('covered', '$TARGET'), ('free', '$TARGET');
INSERT INTO neo_questions (id, ask_id, text, kind, todos, created_at) VALUES
  ('q-parent', 'ask-parent', 'Which release?', 'reply', '[\"covered\"]', $NOW);"
echo "seeded: a card on the parent ask covers the child ask's only todo"

"$HERE/launch.sh" "$PORT" "$RUN"
view() {
  bun "$HERE/rpc.ts" neo.snapshot '{}' | bun -e '
    const text = await Bun.stdin.text();
    const view = JSON.parse(text.slice(text.indexOf("{"))).reply;
    const state = (id) => view.todoAsks.find((entry) => entry.ask.id === id)?.state ?? "missing";
    console.log(`child=${state("ask-child")} parent=${state("ask-parent")} needsYou=${view.needsYou}`);'
}
started() { sqlite3 -readonly "$DB" "SELECT CASE WHEN started_at IS NULL THEN 'unstarted' ELSE 'started' END FROM neo_todos WHERE id = '$1'"; }
wait_started() {
  for _ in $(seq 1 90); do
    [ "$(started "$1")" = started ] && return 0
    sleep 2
  done
  return 1
}

before=$(view)
echo "list before the answer: $before"
[ "$before" = 'child=waiting parent=waiting needsYou=2' ]
wait_started free || { echo "the todo with no card never started, so the hold is not shown"; exit 1; }
echo "runner before the answer: covered=$(started covered) free=$(started free)"
[ "$(started covered)" = unstarted ] || { echo "the covered todo started under an open card"; exit 1; }

bun "$HERE/rpc.ts" neo.question.answer '{"questionId":"q-parent","answer":"The next one"}' >/dev/null
[ "$(sqlite3 -readonly "$DB" "SELECT state FROM neo_questions WHERE id = 'q-parent'")" = answered ]
wait_started covered || { echo "the covered todo never started after its card was answered"; exit 1; }
after=$(view)
echo "list after the answer: $after   covered=$(started covered)"
case "$after" in *waiting*) echo "an ask still shows as waiting with no open card"; exit 1 ;; esac
[ "$(sqlite3 -readonly "$DB" "SELECT count(*) FROM neo_questions WHERE state = 'open'")" = 0 ]
echo "PASS: the list, the counts and the runner agree before and after the answer"
