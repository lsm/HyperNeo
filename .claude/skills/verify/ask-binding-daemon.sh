#!/usr/bin/env bash
set -euo pipefail
RUN=${1:?usage: ask-binding-daemon.sh <fresh-absolute-run-dir>}
case "$RUN" in /*) ;; *) echo 'Use an absolute run directory' >&2; exit 2 ;; esac
if [[ -e "$RUN" ]]; then echo 'Use a fresh run directory' >&2; exit 2; fi
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
if SOURCE_HEAD=$(git rev-parse HEAD 2>/dev/null); then
  if [[ -n "${2:-}" && "$2" != "$SOURCE_HEAD" ]]; then
    echo 'Requested source SHA does not match Git HEAD' >&2; exit 2
  fi
  HEAD_SOURCE=git
else
  SOURCE_HEAD=${2:?An archived snapshot needs its source commit SHA}
  [[ "$SOURCE_HEAD" =~ ^[0-9a-f]{40}$ ]] || { echo 'Use a full source commit SHA' >&2; exit 2; }
  HEAD_SOURCE=declared-archive
fi
mkdir -p "$RUN/home" "$RUN/bin" "$RUN/tmp"
env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" NODE_ENV=test HYPERNEO_DATA_DIR="$RUN/data" \
  PATH="$RUN/bin:$(dirname "$(command -v bun)"):/usr/bin:/bin:/usr/sbin" \
  bun .claude/skills/verify/ask-binding-daemon.ts "$RUN" "$SOURCE_HEAD" "$HEAD_SOURCE"
