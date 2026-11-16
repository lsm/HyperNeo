#!/usr/bin/env bash
# Resume two sessions whose synthetic transcripts lost an assistant tool_use line.
set -euo pipefail
RUN=${1:?usage: transcript-repair.sh <fresh-absolute-run-dir> [port]}
PORT=${2:-9378}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" || "$PORT" = 8399 ]]; then echo 'Use a fresh run directory and an isolated port' >&2; exit 2; fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $PORT is busy"; exit 1; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home/workspace" "$RUN/data" "$RUN/tmp" "$RUN/evidence"
DB="$RUN/data/daemon.db"
DAEMON_PID=
clean=(env -i HOME="$RUN/home" PATH="$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin"
  TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
stop_daemon() {
  if [[ -n "$DAEMON_PID" ]]; then
    kill "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
    DAEMON_PID=
  fi
}
trap stop_daemon EXIT
start_daemon() {
  (cd "$REPO" && exec "${clean[@]}" bun packages/cli/main.ts --host 127.0.0.1 --port "$PORT" \
    --db-path "$DB" >>"$RUN/daemon.log" 2>&1) &
  DAEMON_PID=$!
  for _ in $(seq 1 120); do
    kill -0 "$DAEMON_PID" 2>/dev/null || { tail -20 "$RUN/daemon.log"; exit 1; }
    curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    sleep 1
  done
  echo 'daemon did not start'; exit 1
}
rpc() { (cd "$REPO" && "${clean[@]}" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"); }
create() {
  rpc rpc:session.create "{\"workspacePath\":\"$RUN/home/workspace\",\"title\":\"$1\"}" \
    >"$RUN/evidence/create-$1.json"
  bun -e 'console.log(JSON.parse(await Bun.file(process.argv[1]).text()).reply.sessionId)' \
    "$RUN/evidence/create-$1.json"
}

start_daemon
BLOB=$(create blob)
LOST=$(create lost)
stop_daemon

PROJECT="$RUN/home/.claude/projects/$(cd "$RUN/home/workspace" && pwd -P | tr '/.' '--')"
mkdir -p "$PROJECT/backups"
tool_result() { printf '{"type":"user","uuid":"u-%s","parentUuid":"gone","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"%s","content":"ok"}]}}\n' "$1" "$1"; }
{
  printf '{"type":"user","uuid":"u0","message":{"role":"user","content":"list files"}}\n'
  printf '{"type":"api-request-blob","sessionId":"sdk-blob","hash":"h1","message":{"role":"assistant","content":[{"type":"thinking","thinking":"plan","signature":"sig-synthetic"},{"type":"tool_use","id":"toolu_blob","name":"Bash","input":{"command":"ls"}}]}}\n'
  tool_result toolu_blob
} >"$PROJECT/sdk-blob.jsonl"
tool_result toolu_lost >"$PROJECT/sdk-lost.jsonl"
for stamp in 2020-01-01 2020-01-02 2020-01-03; do echo old >"$PROJECT/backups/sdk-blob.jsonl.backup.$stamp"; done
echo other >"$PROJECT/backups/sdk-other.jsonl.backup.2020-01-01"
sqlite3 "$DB" "UPDATE sessions SET sdk_session_id = 'sdk-blob' WHERE id = '$BLOB';
  UPDATE sessions SET sdk_session_id = 'sdk-lost' WHERE id = '$LOST';"
start_daemon

failed=0
fail() { echo "FAIL: $1"; failed=1; }

rpc rpc:session.sdkResumeChoice \
  "{\"sessionId\":\"$BLOB\",\"choice\":\"leave_as_is\",\"messageUuid\":\"card-blob\"}" \
  >"$RUN/evidence/resume-blob.json" 2>&1 || true
bun -e '
const lines = (await Bun.file(process.argv[1]).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l));
const i = lines.findIndex((l) => l.type === "assistant");
const ok = i >= 0 && lines[i].message.content[0].signature === "sig-synthetic" &&
  lines[i + 1]?.message?.content?.[0]?.tool_use_id === "toolu_blob" && lines[i + 1].parentUuid === lines[i].uuid &&
  lines[i].parentUuid === "u0";
console.log(JSON.stringify({ restoredAssistantLine: i, ok }));
process.exit(ok ? 0 : 1);' "$PROJECT/sdk-blob.jsonl" >"$RUN/evidence/blob-transcript.json" || fail 'blob transcript not repaired'
ls "$PROJECT/backups" | sort >"$RUN/evidence/backups.txt"
own=$(grep -c '^sdk-blob.jsonl.backup.' "$RUN/evidence/backups.txt" || true)
[[ $own = 2 ]] || fail "expected 2 sdk-blob backups, saw $own"
grep -q '^sdk-blob.jsonl.backup.2020-01-03$' "$RUN/evidence/backups.txt" || fail 'newest old backup removed'
grep -q '^sdk-other.jsonl.backup.2020-01-01$' "$RUN/evidence/backups.txt" || fail 'other session backup removed'

rpc rpc:session.sdkResumeChoice \
  "{\"sessionId\":\"$LOST\",\"choice\":\"leave_as_is\",\"messageUuid\":\"card-lost\"}" \
  >"$RUN/evidence/resume-lost.json" 2>&1 || true
grep -q 'could not be repaired: Could not find tool_use message for toolu_lost' "$RUN/evidence/resume-lost.json" ||
  fail 'resume error does not say could not be repaired'
grep -q 'was not found' "$RUN/evidence/resume-lost.json" && fail 'resume error still says not found'

rpc rpc:providers.create \
  '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' \
  >"$RUN/evidence/provider.json"
rpc rpc:message.send "{\"sessionId\":\"$LOST\",\"content\":\"hello\"}" >"$RUN/evidence/send-lost.json" 2>&1 || true
card=''
for _ in $(seq 1 30); do
  rpc rpc:message.sdkMessages "{\"sessionId\":\"$LOST\",\"limit\":50}" >"$RUN/evidence/messages-lost.json" 2>&1 || true
  card=$(grep -o '"repairError": *"[^"]*"' "$RUN/evidence/messages-lost.json" | head -1 || true)
  [[ -n "$card" ]] && break
  sleep 1
done
echo "card: $card" >"$RUN/evidence/card.txt"
[[ "$card" == *'Could not find tool_use message for toolu_lost'* ]] || fail 'resume card has no repair reason'

echo "blob transcript: $(cat "$RUN/evidence/blob-transcript.json")"
echo "backups: $(tr '\n' ' ' <"$RUN/evidence/backups.txt")"
echo "lost resume: $(tr -d '\n' <"$RUN/evidence/resume-lost.json" | cut -c1-300)"
echo "lost $card"
stop_daemon
[[ $failed = 0 ]] || exit 1
echo PASS
