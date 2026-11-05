#!/bin/bash
# usage: provider-off-session.sh <run-dir> <none|other-on>. Needs VERIFY_PORT, HYPERNEO_DATA_DIR,
# VERIFY_MOCK_PORT and a fresh launch.sh run with no provider rows.
set -euo pipefail
RUN=${1:?run dir}; MODE=${2:?none|other-on}
DB="$RUN/data/daemon.db"; RPC="$(dirname "$0")/rpc.ts"; EVIDENCE="$RUN/evidence/provider-off-$MODE.txt"
mkdir -p "$RUN/ws" "$RUN/evidence"; git -C "$RUN/ws" init -q
sql() { sqlite3 -readonly "$DB" "$1"; }
bun "$RPC" rpc:space.create "{\"name\":\"Old space\",\"workspacePath\":\"$RUN/ws\"}" > /dev/null
bun "$RPC" neo.open '{}' > /dev/null
S="space:chat:$(sql "SELECT id FROM spaces LIMIT 1")"
COLS=$(sql "SELECT group_concat(name) FROM pragma_table_info('sessions') WHERE name NOT IN ('id','type','config')")
sqlite3 "$DB" "PRAGMA busy_timeout=5000; INSERT INTO sessions (id,type,config,$COLS)
  SELECT '$S','space_chat',json_set(config,'$.provider','anthropic','$.model','sonnet'),$COLS FROM sessions LIMIT 1" > /dev/null

if [ "$MODE" = other-on ]; then
  bun "$RPC" rpc:providers.create "{\"params\":{\"providerId\":\"custom:mock\",\"displayName\":\"Mock\",\"kind\":\"custom_endpoint\",\"authType\":\"api_key\",\"isEnabled\":true,\"isDefault\":false,\"sortOrder\":1,\"baseUrl\":\"http://127.0.0.1:$VERIFY_MOCK_PORT\",\"customEndpointConfigJson\":\"{\\\"id\\\":\\\"mock\\\",\\\"name\\\":\\\"Mock\\\",\\\"baseUrl\\\":\\\"http://127.0.0.1:$VERIFY_MOCK_PORT\\\",\\\"protocol\\\":\\\"anthropic\\\",\\\"models\\\":[{\\\"id\\\":\\\"mock-model\\\",\\\"name\\\":\\\"Mock model\\\"}]}\"},\"credentials\":{\"apiKey\":\"synthetic-test-key\"}}" > "$RUN/evidence/provider-create.json"
fi

for i in 1 2 3 4 5 6; do
  bun "$RPC" rpc:message.send "{\"sessionId\":\"$S\",\"content\":\"queued $i\"}" > /dev/null &
done
wait
sleep 12
{
  echo "session: $(sql "SELECT json_extract(config,'$.provider'), json_extract(config,'$.model') FROM sessions WHERE id='$S'")"
  echo "jobs: $(sql "SELECT status, count(*) FROM job_queue WHERE queue='message_delivery' AND json_extract(payload,'$.sessionId')='$S' GROUP BY 1")"
  echo "messages: $(sql "SELECT send_status, count(*) FROM sdk_messages WHERE session_id='$S' AND message_type='user' GROUP BY 1")"
  echo "notices: $(sql "SELECT count(*) FROM sdk_messages WHERE session_id='$S' AND message_type='assistant' AND sdk_message LIKE '%provider%'")"
  echo "internal errors: $(grep -c 'is not registered; cannot prepare' "$RUN/daemon.log" || true)"
} | tee "$EVIDENCE"
if [ "$MODE" = none ]; then
  bun "$RPC" rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' > /dev/null
  sleep 45
  echo "after login: $(sql "SELECT send_status, count(*) FROM sdk_messages WHERE session_id='$S' AND message_type='user' GROUP BY 1")" | tee -a "$EVIDENCE"
fi
