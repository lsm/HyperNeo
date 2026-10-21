#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?fresh absolute run directory}
PORT=${2:-9437}
ASR_PORT=${3:-9438}
[[ "$RUN" = /* && ! -e "$RUN" && "$PORT" != 8399 && "$ASR_PORT" != 8399 && "$PORT" != "$ASR_PORT" ]]
for port in "$PORT" "$ASR_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then exit 2; fi
done
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence" "$RUN/bin"
cp .claude/skills/verify/gh-stub.sh "$RUN/bin/gh"
clean=(env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" TMPDIR="$RUN" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_WORKSPACE_PATH="$RUN")
"${clean[@]}" bun .claude/skills/verify/voice-batch-asr.ts "$ASR_PORT" > "$RUN/asr.log" 2>&1 &
asr=$!
echo "$asr" > "$RUN/asr.pid"
cleanup() {
  bash .claude/skills/verify/stop.sh "$RUN"
  kill "$asr" 2>/dev/null || true
  wait "$asr" 2>/dev/null || true
}
trap cleanup EXIT
start() {
  "${clean[@]}" bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" >> "$RUN/daemon.log" 2>&1 &
  daemon=$!
  echo "$daemon" > "$RUN/daemon.pid"
  for _ in $(seq 1 100); do
    if lsof -nP -a -p "$daemon" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then return; fi
    kill -0 "$daemon"
    sleep 0.25
  done
  return 1
}
start
"${clean[@]}" bun .claude/skills/verify/voice-recording-retries.ts "$RUN" "$PORT" "$ASR_PORT" "${4:-initial}"
if [[ "${4:-initial}" == preflight ]]; then exit 0; fi
bash .claude/skills/verify/stop.sh "$RUN"
start
"${clean[@]}" bun .claude/skills/verify/voice-recording-retries.ts "$RUN" "$PORT" "$ASR_PORT" restarted
"${clean[@]}" bun .claude/skills/verify/voice-recording-retries.ts "$RUN" "$PORT" "$ASR_PORT" pending
kill -KILL "$daemon"
wait "$daemon" 2>/dev/null || true
start
"${clean[@]}" bun .claude/skills/verify/voice-recording-retries.ts "$RUN" "$PORT" "$ASR_PORT" interrupted
