#!/bin/bash
set -euo pipefail
: "${RUN:?run through with-run.sh}"
if [ "$(uname -s)" = Darwin ]; then
  bash .claude/skills/verify/resource-check.sh
fi
PORT=${1:-19346}
export HYPERNEO_DATA_DIR="$RUN/data" VERIFY_PORT="$PORT"
trap 'bash .claude/skills/verify/stop.sh "$RUN"' EXIT
bun .claude/skills/verify/composer-insets-build.ts
bash .claude/skills/verify/launch.sh "$PORT" "$RUN"
bun .claude/skills/verify/rpc.ts rpc:settings.global.update \
  "{\"updates\":{\"language\":\"en\",\"voice\":{\"enabled\":true,\"endpoint\":\"http://127.0.0.1:$PORT/synthetic-asr-unused\",\"model\":\"synthetic\",\"mode\":\"batch\",\"allowPrivateNetwork\":true}}}" > "$RUN/evidence/settings.json"
if [ "${VERIFY_REVIEW_ONLY:-0}" != 1 ]; then
  node .claude/skills/verify/composer-frame.mjs "$PORT" "$RUN"
fi
node .claude/skills/verify/composer-review.mjs "$PORT" "$RUN"
