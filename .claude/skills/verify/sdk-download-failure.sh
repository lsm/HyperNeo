#!/usr/bin/env bash
set -euo pipefail
BIN=${1:?compiled binary required}
RUN=${2:?fresh absolute run directory required}
PORT=${3:-9427}
MOCK=${4:-9428}
MODE=${5:-connection}
[[ "$RUN" = /* && ! -e "$RUN" && "$PORT" != 8399 && "$MOCK" != 8399 && "$PORT" != "$MOCK" ]]
for port in "$PORT" "$MOCK"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is busy" >&2; exit 1; fi
done
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cat > "$RUN/bin/curl" <<'CURL'
#!/bin/sh
printf 'curl\n' >> "$HYPERNEO_DATA_DIR/download.log"
if [ "$DOWNLOAD_FIXTURE" = curl-network ]; then exit 7; fi
printf '<html>blocked</html>'
CURL
chmod +x "$RUN/bin/curl"
if [[ "$MODE" != html && "$MODE" != curl-network ]]; then
  cat > "$RUN/bin/npm" <<'NPM'
#!/bin/sh
printf 'npm\n' >> "$HYPERNEO_DATA_DIR/download.log"
if [ "$DOWNLOAD_FIXTURE" = slow ]; then /bin/sleep 65; fi
exit 7
NPM
  chmod +x "$RUN/bin/npm"
fi
clean=(env -i HOME="$RUN/home" PATH="$RUN/bin" TMPDIR="$RUN" NODE_ENV=test)
"${clean[@]}" "$(command -v bun)" .claude/skills/verify/neo-model-settings-mock.ts "$MOCK" > "$RUN/mock.log" 2>&1 &
MOCK_PID=$!
"${clean[@]}" DOWNLOAD_FIXTURE="$MODE" HYPERNEO_MESSAGE_DELIVERY_MAX_RETRIES="${VERIFY_MESSAGE_RETRIES:-8}" HYPERNEO_DATA_DIR="$RUN/data" ANTHROPIC_BASE_URL="http://127.0.0.1:$MOCK" "$BIN" --port "$PORT" --db-path "$RUN/data/daemon.db" > "$RUN/daemon.log" 2>&1 &
PID=$!
trap 'kill "$PID" "$MOCK_PID" 2>/dev/null || true; wait "$PID" "$MOCK_PID" 2>/dev/null || true' EXIT
rpc() { VERIFY_PORT=$PORT HYPERNEO_DATA_DIR="$RUN/data" bun .claude/skills/verify/rpc.ts "$@"; }
for _ in $(seq 1 120); do
  kill -0 "$PID"
  /usr/bin/curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.25
done
rpc rpc:providers.create '{"params":{"providerId":"anthropic","displayName":"Anthropic (mock)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' > "$RUN/evidence/provider.json"
SESSION=$(rpc rpc:session.create "{\"workspacePath\":\"$RUN/home\",\"worktreeMode\":\"direct\"}" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).reply.sessionId)')
WAIT=4
[[ "$MODE" != slow ]] || WAIT=47
rpc rpc:message.send "{\"sessionId\":\"$SESSION\",\"content\":\"hello\"}" "$WAIT" > "$RUN/evidence/send.json"
rpc rpc:state.session "{\"sessionId\":\"$SESSION\"}" > "$RUN/evidence/state.json"
rpc rpc:session.get "{\"sessionId\":\"$SESSION\"}" > "$RUN/evidence/session.json"
rpc rpc:message.sdkMessages "{\"sessionId\":\"$SESSION\",\"limit\":200}" > "$RUN/evidence/messages.json"
bun -e 'const r=JSON.parse(await Bun.file(process.argv[1]).text()).reply; const e=r.error; const episode=r.sessionInfo.metadata.queryFailureEpisode; if(e?.details?.metadata?.kind!=="package_download_failure" || e.details.category!=="session" || !(/^(Can\x27t download Claude Code:|Claude Code is still downloading)/.test(e.message)) || /JSON|ETIMEDOUT|ECONNREFUSED/.test(e.message) || episode?.failures!==0 || r.agentState.status!=="idle") { console.error(JSON.stringify({error:e,episode,status:r.agentState.status})); process.exit(1); } console.log("session_cause=package_download_failure governor_failures=0 status=idle");' "$RUN/evidence/state.json"
if [[ "$MODE" = slow ]]; then
  bun -e 'const e=JSON.parse(await Bun.file(process.argv[1]).text()).reply.error; if(e.message!=="Claude Code is still downloading. Try again shortly.") process.exit(1); console.log("slow_download=still_running");' "$RUN/evidence/state.json"
fi
if [[ -n "${VERIFY_WEB:-}" ]]; then
  bun .claude/skills/verify/sdk-download-failure-web.mjs "$RUN" "$PORT" "$SESSION" "$VERIFY_WEB" "$MODE"
fi
if [[ "$MODE" = slow && "${VERIFY_WEB:-}" = after ]]; then
  cp "$RUN/daemon.log" "$RUN/evidence/daemon.log"
  printf 'slow_browser_retry=joined_existing_download exit=0\n'
  exit 0
fi
before=$(wc -l < "$RUN/data/download.log" | tr -d ' ')
rpc daemon.retryClaudeDownload '{}' > "$RUN/evidence/retry.json"
after=$(wc -l < "$RUN/data/download.log" | tr -d ' ')
rpc rpc:message.sdkMessages "{\"sessionId\":\"$SESSION\",\"limit\":200}" > "$RUN/evidence/messages-after.json"
bun -e 'const a=JSON.parse(await Bun.file(process.argv[1]).text()).reply.sdkMessages; const b=JSON.parse(await Bun.file(process.argv[2]).text()).reply.sdkMessages; if(JSON.stringify(a)!==JSON.stringify(b)) process.exit(1); console.log(`messages_before=${a.length} messages_after=${b.length}`)' "$RUN/evidence/messages.json" "$RUN/evidence/messages-after.json"
cp "$RUN/daemon.log" "$RUN/evidence/daemon.log"
if [[ "$MODE" = html || "$MODE" = curl-network ]]; then
  [[ $(/usr/bin/grep -vc '^curl$' "$RUN/data/download.log" || true) -eq 0 ]]
else
  [[ $(/usr/bin/grep -vc '^npm$' "$RUN/data/download.log" || true) -eq 0 ]]
fi
printf 'download_attempts_before=%s after=%s\n' "$before" "$after"
if [[ "$MODE" = slow ]]; then
  [[ "$after" -eq "$before" ]]
else
  [[ "$after" -eq $((before + 1)) ]]
fi
bun -e 'const r=JSON.parse(await Bun.file(process.argv[1]).text()).reply; console.log(JSON.stringify(r)); if (r.accepted !== false || !r.reason?.includes("Can\x27t download Claude Code")) process.exit(1)' "$RUN/evidence/retry.json"
printf 'retry_requests=1 exit=0\n'
