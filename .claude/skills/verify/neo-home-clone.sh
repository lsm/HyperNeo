#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: neo-home-clone.sh <fresh-absolute-run-dir> [shared|missing]}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
[[ ! -e "$RUN" ]]
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$RUN/home" "$RUN/data" "$RUN/bin" "$RUN/evidence"
cp "$REPO/.claude/skills/verify/gh-stub.sh" "$RUN/bin/gh"
cd "$REPO"
env -i HOME="$RUN/home" PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  TMPDIR="$RUN" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" HYPERNEO_WORKSPACE_PATH="$RUN" \
  GIT_CONFIG_GLOBAL="$RUN/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
  bun .claude/skills/verify/neo-home-clone.ts "$RUN" "${2:-shared}"
