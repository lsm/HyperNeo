#!/bin/bash
# Usage: VERIFY_KEEP_RUN=1 with-run.sh bash .claude/skills/verify/goal-own-session.sh <port>
set -euo pipefail
PORT=${1:?usage: goal-own-session.sh <port>}
: "${RUN:?run under with-run.sh}"
cd "$(dirname "$0")/../../.."
trap 'bash .claude/skills/verify/stop.sh "$RUN" >/dev/null 2>&1 || true' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
VERIFY_MOCK=goal-session-script-api.ts .claude/skills/verify/launch.sh "$PORT" "$RUN"
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
bun .claude/skills/verify/rpc.ts rpc:providers.create \
  '{"params":{"providerId":"anthropic","displayName":"Anthropic (dev proxy)","kind":"built_in","authType":"api_key","isEnabled":true,"isDefault":true,"sortOrder":0},"credentials":{"apiKey":"sk-devproxy-test-key"}}' > /dev/null
bun .claude/skills/verify/goal-own-session.ts "$PORT" "$RUN"
