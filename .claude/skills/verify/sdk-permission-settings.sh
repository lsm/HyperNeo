#!/bin/bash
set -euo pipefail
PORT=${1:?usage: sdk-permission-settings.sh <port> [run-dir]}
RUN=${2:-$(mktemp -d "${TMPDIR:-/tmp}/hyperneo-verify.XXXXXX")}
HERE=$(cd "$(dirname "$0")" && pwd)
trap '"$HERE/stop.sh" "$RUN"' EXIT
"$HERE/launch.sh" "$PORT" "$RUN"
NODE_PATH="${PLAYWRIGHT_NODE_PATH:-/opt/homebrew/lib/node_modules/@playwright/cli/node_modules}" \
  node "$HERE/sdk-permission-settings-view.mjs" "$PORT" "$RUN"
echo "evidence: $RUN/evidence"
