#!/bin/bash
set -euo pipefail
EVIDENCE=${1:?usage: mcp-oauth-settings.sh <absolute evidence directory>}
[[ "$EVIDENCE" = /* ]] || { echo 'Evidence directory must be absolute'; exit 2; }
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PORT=${VERIFY_PORT:-19331}
[ "$PORT" != 8399 ] || exit 1
RUN=$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")
export RUN HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
FAKE_PID=
cleanup() {
  [ -z "$FAKE_PID" ] || kill "$FAKE_PID" 2>/dev/null || true
  bash "$ROOT/.claude/skills/verify/stop.sh" "$RUN"
  rm -rf "$RUN"
}
trap cleanup EXIT
cd "$ROOT"
mkdir -p "$EVIDENCE"
env -i HOME="$RUN" PATH="$PATH" bun .claude/skills/verify/mcp-oauth-settings-fake.ts > "$RUN/fake.log" 2>&1 &
FAKE_PID=$!
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
for _ in $(seq 50); do grep -q '^fake:' "$RUN/fake.log" && break; sleep 0.2; done
grep -q '^fake:' "$RUN/fake.log" || { cat "$RUN/fake.log"; exit 1; }
rpc() {
  env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
    VERIFY_PORT="$PORT" bun .claude/skills/verify/rpc.ts "$@"
}
rpc rpc:mcp.registry.create \
  '{"name":"oauth-fixture","sourceType":"http","url":"http://127.0.0.1:18347/mcp"}' > "$EVIDENCE/create.json"
rpc rpc:mcp.registry.create \
  '{"name":"plain-http","sourceType":"http","url":"http://127.0.0.1:18348/mcp"}' > /dev/null
rpc rpc:mcp.registry.create \
  '{"name":"jira","sourceType":"http","url":"https://mcp.atlassian.com/v2/mcp"}' > /dev/null
rpc rpc:mcp.registry.create \
  '{"name":"basecamp","sourceType":"http","url":"https://mcp.basecamp.com/mcp"}' > /dev/null
rpc rpc:mcp.registry.create \
  '{"name":"slack","sourceType":"http","url":"https://mcp.slack.com/mcp"}' > /dev/null
PAIR_CODE=$(env -i HOME="$RUN/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  HYPERNEO_SESSION_DOOR="$RUN/data/session-door.sock" bun run packages/cli/main.ts pair --kind human \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["code"])')
export PAIR_CODE VERIFY_DB="$RUN/data/daemon.db"
node .claude/skills/verify/mcp-oauth-settings-web.mjs "$PORT" "$EVIDENCE"
