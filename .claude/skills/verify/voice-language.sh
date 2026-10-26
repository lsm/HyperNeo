#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?fresh absolute run directory}
PORT=${2:-9427}
ASR_PORT=${3:-9428}
[[ "$RUN" = /* && ! -e "$RUN" && "$PORT" != 8399 && "$ASR_PORT" != 8399 && "$PORT" != "$ASR_PORT" ]]
for port in "$PORT" "$ASR_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then exit 2; fi
done
mkdir -p "$RUN/home" "$RUN/data" "$RUN/evidence" "$RUN/bin"
cp .claude/skills/verify/gh-stub.sh "$RUN/bin/gh"
clean=(env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" TMPDIR="$RUN" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_WORKSPACE_PATH="$RUN" HYPERNEO_LOG_FILE="$RUN/data/voice.jsonl")
"${clean[@]}" bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
pid=$!
echo "$pid" > "$RUN/daemon.pid"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
for _ in $(seq 1 100); do
  if lsof -nP -a -p "$pid" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  kill -0 "$pid"
  sleep 0.25
done
lsof -nP -a -p "$pid" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null
node .claude/skills/verify/voice-language.mjs "$RUN" "$PORT" "$ASR_PORT"
