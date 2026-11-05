#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: ask-binding-daemon.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/bin" "$RUN/tmp"
cd "$REPO"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  bun .claude/skills/verify/ask-binding-daemon.ts "$RUN"
git rev-parse HEAD > "$RUN/evidence/head.txt"
