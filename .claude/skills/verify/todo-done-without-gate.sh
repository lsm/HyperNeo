#!/bin/bash
# todo-done-without-gate.sh — Neo marks a never-started todo with an unmet check
# done through neo.todo.done: nothing refuses it, the card asked about it is
# retired, and the todo that waited for it starts.
#
# Usage: .claude/skills/verify/with-run.sh bash -c \
#   '.claude/skills/verify/todo-done-without-gate.sh "$RUN" 9367'
set -euo pipefail
RUN=${1:?usage: todo-done-without-gate.sh <run-dir> [port]}
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
CHECK="{\"pack\":\"core\",\"kind\":\"evidence\",\"params\":{\"path\":\"$RUN/never-written.md\"}}"
sqlite3 "$DB" "
INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at) VALUES
  ('ask-done', '$ROOT', 'Done', 'Done', 'open', $NOW, $NOW);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, instruction, state, approved_at, depends_on, created_at, updated_at) VALUES
  ('gated', 'ask-done', 1, 'Gated step', 'File written', '$CHECK', NULL, 'todo', $NOW, NULL, $NOW, $NOW),
  ('next', 'ask-done', 2, 'Next step', 'Seen', NULL, 'Do it', 'todo', $NOW, '[\"gated\"]', $NOW, $NOW);
INSERT INTO neo_todo_sessions (todo_id, target) VALUES ('next', '$TARGET');
INSERT INTO neo_questions (id, ask_id, text, kind, todo_id, todos, created_at) VALUES
  ('q-gated', 'ask-done', 'Is this step still needed?', 'reply', 'gated', '[\"gated\"]', $NOW);"
echo "seeded: a never-started todo with an unmet check, a card asked about it, and a todo that waits for it"

"$HERE/launch.sh" "$PORT" "$RUN"
row() { sqlite3 -readonly "$DB" "SELECT state || '/' || CASE WHEN started_at IS NULL THEN 'unstarted' ELSE 'started' END FROM neo_todos WHERE id = '$1'"; }
reply() {
  bun "$HERE/rpc.ts" "$1" "$2" | bun -e '
    const text = await Bun.stdin.text();
    const reply = JSON.parse(text.slice(text.indexOf("{"))).reply;
    console.log(reply.ok ? `ok todo=${reply.todo?.state}` : `refused ${String(reply.reason ?? reply.error?.message ?? "").split(":")[0]}`);'
}

sleep 20
echo "before: gated=$(row gated) next=$(row next)"
[ "$(row next)" = todo/unstarted ] || { echo "the waiting todo started before its prerequisite was done"; exit 1; }
closed=$(reply neo.todo.close '{"todoId":"gated","reason":"No longer needed"}')
echo "neo.todo.close, the gated name: $closed"
[ "$closed" = 'refused card_unanswered' ]

marked=$(reply neo.todo.done '{"todoId":"gated"}')
echo "neo.todo.done: $marked"
[ "$marked" = 'ok todo=done' ]
[ "$(row gated)" = done/unstarted ]
card=$(sqlite3 -readonly "$DB" "SELECT state FROM neo_questions WHERE id = 'q-gated'")
echo "card asked about it: $card"
[ "$card" = retired ]
for _ in $(seq 1 90); do
  case "$(row next)" in */started) break ;; esac
  sleep 2
done
echo "after: gated=$(row gated) next=$(row next)"
case "$(row next)" in */started) ;; *) echo "the waiting todo never started"; exit 1 ;; esac
echo "PASS: done without a reason, a passed check or an answered card; the waiting todo started"
