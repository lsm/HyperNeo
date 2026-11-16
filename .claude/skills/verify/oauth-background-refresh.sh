#!/usr/bin/env bash
set -euo pipefail
run="${1:?usage: oauth-background-refresh.sh <fresh run dir>}"
mkdir -p "$run/home"
exec env -i HOME="$run/home" PATH="$PATH" NODE_ENV=test HYPERNEO_DATA_DIR="$run/data" \
  LOG_LEVEL=warn bun "$(dirname "$0")/oauth-background-refresh.ts" "$run"
