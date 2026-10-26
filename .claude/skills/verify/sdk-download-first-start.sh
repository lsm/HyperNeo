#!/usr/bin/env bash
set -euo pipefail
USAGE='usage: sdk-download-first-start.sh <compiled-hyperneo-binary> <fresh-absolute-run-dir> [port] [mock-port]'
BIN=${1:?$USAGE}
RUN=${2:?$USAGE}
PORT=${3:-9411}
MOCK=${4:-9412}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" && "$PORT" != 8399 && "$MOCK" != 8399 && "$PORT" != "$MOCK" ]]
for candidate in "$PORT" "$MOCK"; do
  if lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $candidate is busy" >&2; exit 1; fi
done
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence"
cd "$REPO"
clean=(env -i HOME="$RUN/home" PATH=/usr/bin:/bin:/usr/sbin TMPDIR="$RUN" NODE_ENV=test)
"${clean[@]}" "$(command -v bun)" .claude/skills/verify/neo-model-settings-mock.ts "$MOCK" > "$RUN/mock-api.log" 2>&1 &
MOCK_PID=$!
"${clean[@]}" HYPERNEO_DATA_DIR="$RUN/data" ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK" \
  "$BIN" --port "$PORT" --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" "$MOCK_PID" 2>/dev/null; wait "$PID" "$MOCK_PID" 2>/dev/null || true' EXIT
rpc() { VERIFY_PORT=$PORT bun .claude/skills/verify/rpc.ts "$@"; }
log_has() { grep -qE "$1" "$RUN/daemon.log"; }
for _ in $(seq 1 120); do kill -0 "$PID"; log_has '\[SDK\] Downloading' && break; sleep 0.25; done
log_has '\[SDK\] Downloading' || { echo 'FAIL: no first-start download (binary already cached?)'; exit 1; }
for _ in $(seq 1 60); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.25; done

rpc rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (mock)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' > "$RUN/evidence/provider.json"
SESSION=$(rpc rpc:session.create "{\"workspacePath\":\"$RUN/home\",\"worktreeMode\":\"direct\"}" | bun -e 'const r=JSON.parse(await Bun.stdin.text()).reply; console.log(r.sessionId)')
rpc rpc:message.send "{\"sessionId\":\"$SESSION\",\"content\":\"hello during first download\"}" > "$RUN/evidence/send.json"
sent_while_downloading=$(log_has '\[SDK\] Claude Code binary (ready|unavailable)' && echo no || echo yes)
echo "session $SESSION sent while downloading: $sent_while_downloading"

for _ in $(seq 1 720); do kill -0 "$PID"; log_has '\[SDK\] Claude Code binary (ready|unavailable)' && break; sleep 0.5; done
answered=no
for _ in $(seq 1 120); do
  n=$(sqlite3 -readonly "$RUN/data/daemon.db" "SELECT count(*) FROM sdk_messages WHERE session_id='$SESSION' AND message_type='assistant'" 2>/dev/null || echo 0)
  [[ "$n" -gt 0 ]] && { answered=yes; break; }
  sleep 0.5
done
sleep 2
cp "$RUN/daemon.log" "$RUN/evidence/daemon.log"
grep -E '^\[SDK\]' "$RUN/daemon.log"
sqlite3 -readonly "$RUN/data/daemon.db" "SELECT message_type, substr(sdk_message,1,160) FROM sdk_messages WHERE session_id='$SESSION' ORDER BY rowid" > "$RUN/evidence/session-messages.txt" || true
worst=$(grep -oE 'Event loop blocked for [0-9]+ms' "$RUN/daemon.log" | grep -oE '[0-9]+' | sort -n | tail -1 || true)
echo "worst event-loop block: ${worst:-none}ms; session answered: $answered"
grep -q '\[SDK\] Claude Code binary ready: ' "$RUN/daemon.log" || { echo 'FAIL: binary was not downloaded'; exit 1; }
[[ -z "$worst" ]] || { echo 'FAIL: event loop blocked during first start'; exit 1; }
[[ "$sent_while_downloading" == yes ]] || { echo 'INCONCLUSIVE: download finished before the message was sent'; exit 1; }
[[ "$answered" == yes ]] || { echo 'FAIL: the session started during the download never answered'; exit 1; }
echo 'PASS: first-start download kept the daemon responsive and the waiting session answered'
