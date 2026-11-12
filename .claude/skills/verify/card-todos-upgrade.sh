#!/bin/bash
# card-todos-upgrade.sh — a database written before cards listed their todos is
# upgraded by a daemon start, and an approved todo under an ask-level question
# is still held afterwards.
#
# Usage: .claude/skills/verify/with-run.sh bash -c \
#   '.claude/skills/verify/card-todos-upgrade.sh "$RUN" 9367'
set -euo pipefail
RUN=${1:?usage: card-todos-upgrade.sh <run-dir> [port]}
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
INSERT INTO neo_asks (id, session_id, title, request, status, created_at, updated_at) VALUES
  ('ask-held', '$ROOT', 'Held', 'Held', 'open', $NOW, $NOW),
  ('ask-free', '$ROOT', 'Free', 'Free', 'open', $NOW, $NOW),
  ('ask-start', '$ROOT', 'Start', 'Start', 'open', $NOW, $NOW);
INSERT INTO neo_todos (id, ask_id, position, title, done_when, instruction, state, blocked_by, approved_at, created_at, updated_at) VALUES
  ('held', 'ask-held', 1, 'Held step', 'Seen', 'Do it', 'todo', NULL, $NOW, $NOW, $NOW),
  ('free', 'ask-free', 1, 'Free step', 'Seen', 'Do it', 'todo', NULL, $NOW, $NOW, $NOW),
  ('waiting', 'ask-start', 1, 'Waiting step', 'Seen', 'Do it', 'blocked', 'question', NULL, $NOW, $NOW);
INSERT INTO neo_todo_sessions (todo_id, target) VALUES
  ('held', '$TARGET'), ('free', '$TARGET');
INSERT INTO neo_questions (id, ask_id, text, kind, created_at) VALUES
  ('q-ask', 'ask-held', 'Which release?', 'reply', $NOW);
INSERT INTO neo_questions (id, ask_id, text, kind, todo_id, created_at) VALUES
  ('q-one', 'ask-start', 'Is this the right step?', 'reply', 'waiting', $NOW);
INSERT INTO neo_questions (id, ask_id, text, kind, start_todos, created_at) VALUES
  ('q-start', 'ask-start', 'Start this?', 'start', '[\"waiting\"]', $NOW);
ALTER TABLE neo_questions DROP COLUMN todos;
DELETE FROM migration_markers WHERE key = 'migration_502';"
[ "$(sqlite3 -readonly "$DB" "SELECT count(*) FROM pragma_table_info('neo_questions') WHERE name = 'todos'")" = 0 ]
echo "seeded legacy cards: no todos column, migration 502 marker removed"

"$HERE/launch.sh" "$PORT" "$RUN"
lists=$(sqlite3 -readonly "$DB" "SELECT id || '=' || todos FROM neo_questions WHERE id IN ('q-ask', 'q-one', 'q-start') ORDER BY id" | tr '\n' ' ')
echo "after upgrade: $lists"
[ "$lists" = 'q-ask=["held"] q-one=["waiting"] q-start=["waiting"] ' ]
read=$(bun "$HERE/rpc.ts" neo.question.get '{"questionId":"q-ask"}' 2>&1 || true)
echo "$read" | tr -d '\n ' | grep -q '"ok":true,"question":{"id":"q-ask".*"state":"open"'
echo "the upgraded card reads through neo.question.get"

state() { sqlite3 -readonly "$DB" "SELECT state || '/' || COALESCE(blocked_by, '-') || '/' || CASE WHEN started_at IS NULL THEN 'unstarted' ELSE 'started' END FROM neo_todos WHERE id = '$1'"; }
for _ in $(seq 1 90); do
  case "$(state free)" in */started) break ;; esac
  sleep 2
done
echo "held: $(state held)   free: $(state free)"
case "$(state free)" in */started) ;; *) echo "the todo with no card never started, so the hold is not shown"; exit 1 ;; esac
case "$(state held)" in */unstarted) ;; *) echo "the approved todo under the ask-level question started"; exit 1 ;; esac
echo "PASS: cards list their todos after the upgrade; the approved todo under the ask-level question is still held"
