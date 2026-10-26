#!/bin/bash
set -euo pipefail
PORT=${1:?usage: neo-worker-permission.sh <port> [run-dir]}
RUN=${2:-$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")}
HERE=$(cd "$(dirname "$0")" && pwd)
FIXTURE="$HERE/../../../packages/daemon/tests/fixtures/claude-b1-cli.ts"
mkdir -p "$RUN/bin" "$RUN/evidence" "$RUN/workspace" "$RUN/home/.claude"
printf '#!/usr/bin/env bun\nawait import(%s);\n' "\"$FIXTURE\"" > "$RUN/bin/claude"
printf '#!/usr/bin/env bun\nprocess.argv.push("--synthetic-desktop-import");\nawait import(%s);\n' "\"$FIXTURE\"" > "$RUN/bin/script"
chmod 700 "$RUN/bin/claude" "$RUN/bin/script"
RC=$(uuidgen | tr 'A-Z' 'a-z')
for args in "claude -p --session-id $RC -n rc-toggle --permission-mode bypassPermissions -- Synthetic-RC-helper" \
  "script -q /dev/null claude --desktop --resume $RC"; do
  (cd "$RUN/workspace" && env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin" $args)
done
trap '"$HERE/stop.sh" "$RUN"' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node "$HERE/neo-worker-permission-view.mjs" "$PORT" "$RUN"
VERIFY_PORT="$PORT" bun "$HERE/rpc.ts" work.start "$(printf '{"adapter":"claude-desktop","place":{"machine":"%s","folder":"%s","name":"Synthetic project"},"title":"P08 synthetic worker","message":"Synthetic task"}' "$(hostname)" "$RUN/workspace")" \
  > "$RUN/evidence/work-start.json" || true
grep '"kind":"prepare"' "$RUN/evidence/native-events.jsonl" | tee "$RUN/evidence/prepare-args.jsonl"
grep '"P08 synthetic worker"' "$RUN/evidence/prepare-args.jsonl" | grep -q '"--permission-mode","acceptEdits"'
echo "launcher received --permission-mode acceptEdits; evidence: $RUN/evidence"
