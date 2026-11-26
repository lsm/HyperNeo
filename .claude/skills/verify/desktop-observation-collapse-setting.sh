#!/bin/bash
set -euo pipefail
PORT=${1:?usage: desktop-observation-collapse-setting.sh <port> [run-dir]}
RUN=${2:-$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$RUN/evidence"
trap '"$HERE/stop.sh" "$RUN"' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node "$HERE/desktop-observation-collapse-setting.mjs" "$PORT" "$RUN"
echo "evidence: $RUN/evidence"
