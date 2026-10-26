#!/usr/bin/env bash
set -euo pipefail
EVIDENCE=${1:?usage: composer-layout.sh <fresh-absolute-evidence-dir> [port]}
PORT=${2:-9374}
ASR_PORT=$((PORT + 1))
[[ "$EVIDENCE" = /* && ! -e "$EVIDENCE" && "$PORT" != 8399 && "$ASR_PORT" != 8399 ]]
bash .claude/skills/verify/resource-check.sh
for p in "$PORT" "$ASR_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $p is busy"; exit 1; fi
done
mkdir "$EVIDENCE"
RUN=$(mktemp -d "${TMPDIR:-/private/tmp}/hn-composer-XXXXXX")
RUN=$(cd "$RUN" && pwd -P)
cleanup() {
  STATUS=$?
  trap - EXIT
  for name in asr-stub daemon; do
    if [[ -f "$RUN/$name.pid" ]]; then
      PID=$(cat "$RUN/$name.pid")
      kill -TERM "$PID" 2>/dev/null || true
      wait "$PID" 2>/dev/null || true
    fi
  done
  cp -R "$RUN/evidence/." "$EVIDENCE/"
  cp "$RUN/daemon.log" "$RUN/asr-stub.log" "$EVIDENCE/" 2>/dev/null || true
  printf '{"exitCode":%s}\n' "$STATUS" > "$EVIDENCE/run-status.json"
  rm -rf "$RUN"
  exit "$STATUS"
}
mkdir -p "$RUN/home" "$RUN/data" "$RUN/tmp" "$RUN/bin" "$RUN/evidence"
trap cleanup EXIT
printf '#!/bin/sh\nexit 1\n' > "$RUN/bin/gh"
chmod +x "$RUN/bin/gh"
ENV=(env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data")
"${ENV[@]}" bun packages/cli/main.ts --port "$PORT" --host 127.0.0.1 --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
echo $! > "$RUN/daemon.pid"
"${ENV[@]}" bun .claude/skills/verify/asr-stub.ts "$ASR_PORT" > "$RUN/asr-stub.log" 2>&1 &
echo $! > "$RUN/asr-stub.pid"
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then break; fi
  kill -0 "$(cat "$RUN/daemon.pid")"
  sleep 1
done
"${ENV[@]}" VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts rpc:settings.global.update "{\"updates\":{\"voice\":{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:$ASR_PORT/v1/audio/transcriptions\",\"model\":\"stub\",\"mode\":\"streaming\",\"streamEndpoint\":\"ws://127.0.0.1:$ASR_PORT/v1/listen\",\"streamProtocol\":\"deepgram\",\"allowPrivateNetwork\":true}}}" > "$RUN/evidence/voice-settings.json"
VERIFY_PLAYWRIGHT=${VERIFY_PLAYWRIGHT:-playwright} node .claude/skills/verify/composer-layout.mjs "$PORT" "$RUN"
