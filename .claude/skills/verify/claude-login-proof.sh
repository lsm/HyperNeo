#!/usr/bin/env bash
set -euo pipefail
run="${1:?usage: claude-login-proof.sh <fresh run dir>}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$run/home"
env -i HOME="$run/home" PATH="$PATH" NODE_ENV=test HYPERNEO_USE_DEV_PROXY=1 \
  HYPERNEO_DATA_DIR="$run/data" LOG_LEVEL=warn \
  bun "$here/claude-login-retry.ts" "$run" fail --serve >"$run/daemon.log" 2>&1 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT
NODE_PATH="${NODE_PATH:-}" VERIFY_BROWSER="${VERIFY_BROWSER:-}" node "$here/claude-login-browser.mjs" "$run"
wait "$daemon"
echo "daemon exit=$?"
