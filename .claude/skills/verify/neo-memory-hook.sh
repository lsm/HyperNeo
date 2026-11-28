#!/bin/bash
set -euo pipefail
PORT=${1:?usage: neo-memory-hook.sh <port> <run-dir>}
RUN=${2:?usage: neo-memory-hook.sh <port> <run-dir>}
DIR=$(cd "$(dirname "$0")" && pwd)
export VERIFY_PORT=$PORT HYPERNEO_DATA_DIR="$RUN/data"
trap 'bash "$DIR/stop.sh" "$RUN" >/dev/null 2>&1 || true' EXIT
VERIFY_MOCK=mock-api-capture.ts bash "$DIR/launch.sh" "$PORT" "$RUN"
rpc() { bun "$DIR/rpc.ts" "$@"; }
rpc rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' >/dev/null
root=$(rpc neo.open '{}' | bun -e 'const t=await Bun.stdin.text();const m=t.match(/"sessionId":\s*"([^"]+)"/);console.log(m?m[1]:"")')
[ -n "$root" ] || { echo "FAIL: neo.open returned no sessionId"; exit 1; }
echo "root=$root"

human_save=$(rpc memory.save '{"key":"x","content":"human write"}')
echo "human memory.save: $human_save"
grep -q memory_not_authorized <<<"$human_save" || { echo "FAIL: human save was not refused"; exit 1; }

DB="$RUN/data/daemon.db"
now=$(($(date +%s) * 1000))
sqlite3 "$DB" "INSERT INTO neo_memories (key, content, created_at, updated_at) VALUES
  ('ci-runs-tests', 'Let CI run the daemon tests, not the laptop.', $now, $now),
  ('pr-size', 'Keep each pull request near 300 production lines.', $now, $now),
  ('eastern-time', 'Tell the human times in US Eastern.', $now, $now);"

search=$(rpc memory.search '{"query":"where do the daemon tests run"}')
echo "human memory.search: $search"
grep -qE '"key": ?"ci-runs-tests"' <<<"$search" || { echo "FAIL: search missed ci-runs-tests"; exit 1; }

rpc neo.message.send "{\"sessionId\":\"$root\",\"requestId\":\"$(uuidgen | tr A-Z a-z)\",\"content\":\"Where should the daemon tests run?\"}" >/dev/null
for _ in $(seq 1 60); do
  results=$(sqlite3 "file:$DB?mode=ro" "SELECT count(*) FROM sdk_messages WHERE session_id='$root' AND message_type='result'")
  [ "$results" -gt 0 ] && break
  sleep 1
done
echo "result rows: $results"
[ "$results" -gt 0 ] || { echo "FAIL: Neo did not finish a turn"; exit 1; }
captured=$(grep -c 'Memories that may apply' "$RUN/mock-api.log" || true)
echo "model requests carrying memories: $captured"
grep -q -- '- ci-runs-tests: Let CI run the daemon tests' "$RUN/mock-api.log" || { echo "FAIL: memory not in model request"; exit 1; }
if grep -q -- '- eastern-time:' "$RUN/mock-api.log"; then echo "FAIL: unrelated memory injected"; exit 1; fi
cp "$RUN/mock-api.log" "$RUN/evidence/mock-api.log"
echo "PASS: human message injected its matching memory; unrelated memory stayed out"
