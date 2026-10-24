#!/bin/bash
# Per-instance work feed scope: with workFeedScope 'own' the Claude and Codex feeds index only
# sessions this instance started; 'all' (the default) indexes every session on the machine.
# Usage: feed-scope.sh <port> (never 8399). Synthetic transcripts live under a temp HOME.
set -euo pipefail
PORT=${1:?usage: feed-scope.sh <port>}
[ "$PORT" = 8399 ] && { echo "refusing 8399"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && { echo "port $PORT is busy"; exit 1; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d "${TMPDIR:-/tmp}/feed-scope.XXXXXX")
H="$RUN/home"
mkdir -p "$H" "$RUN/data" "$RUN/evidence"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
MINE_T=11111111-1111-4111-8111-111111111111
FOREIGN_T=33333333-3333-4333-8333-333333333333
PROJECT="$H/.claude/projects/-Users-me-focus-heron"
ROLLOUTS="$H/.codex/sessions/2026/10/24"
mkdir -p "$PROJECT" "$ROLLOUTS"
for id in cli-mine cli-foreign; do
  printf '{"type":"user","uuid":"u-%s","timestamp":"%s","cwd":"/Users/me/focus/heron","message":{"content":"heron %s"}}\n' \
    "$id" "$NOW" "$id" > "$PROJECT/$id.jsonl"
done
for id in $MINE_T $FOREIGN_T; do
  printf '{"type":"session_meta","payload":{"id":"%s","cwd":"/Users/me/focus/heron"}}\n{"type":"response_item","timestamp":"%s","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"heron %s"}]}}\n' \
    "$id" "$NOW" "$id" > "$ROLLOUTS/rollout-2026-10-24T05-00-00-$id.jsonl"
done
cd "$ROOT"
env -i HOME="$H" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  bun run packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" \
  < /dev/null > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; wait $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
DB="$RUN/data/daemon.db"
rpc() { VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"; }
feed() {
  for queue in work.feed.claude work.feed.codex; do
    sqlite3 "$DB" "INSERT INTO job_queue (id, queue, payload, run_at, created_at)
      VALUES ('$1-$queue', '$queue', '{}', 0, 0)"
  done
  for _ in $(seq 1 30); do
    [ "$(sqlite3 -readonly "$DB" "SELECT COUNT(*) FROM job_queue WHERE id LIKE '$1-%' AND status IN ('completed','failed','dead')")" = 2 ] && break
    sleep 1
  done
  sqlite3 -readonly "$DB" "SELECT id, status, coalesce(error, '') FROM job_queue WHERE id LIKE '$1-%' ORDER BY id"
  echo "$1 feed sessions: $(sqlite3 -readonly "$DB" "SELECT group_concat(kind || ':' || session_id, ' ') FROM (SELECT DISTINCT kind, session_id FROM message_search_content WHERE kind IN ('claude','codex') ORDER BY kind, session_id)")"
}
sqlite3 "$DB" "INSERT INTO work_started_sessions VALUES ('claude-code', 'cli-mine', 1), ('codex-desktop', '$MINE_T', 1)"
rpc rpc:settings.global.update '{"updates":{"workFeedScope":"own"}}' > "$RUN/evidence/own-setting.json"
feed own | tee "$RUN/evidence/own.txt"
rpc rpc:settings.global.update '{"updates":{"workFeedScope":"all"}}' > "$RUN/evidence/all-setting.json"
feed all | tee "$RUN/evidence/all.txt"
echo "run dir: $RUN"
