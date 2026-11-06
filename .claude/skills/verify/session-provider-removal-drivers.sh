#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
bash .claude/skills/verify/resource-check.sh
bash .claude/skills/verify/with-run.sh bash -c '
  mkdir -p "$RUN/home" "$RUN/tmp" "$RUN/bin"
  cp .claude/skills/verify/gh-stub.sh "$RUN/bin/gh"
  cd packages/daemon
  env -i HOME="$RUN/home" TMPDIR="$RUN/tmp" PATH="$RUN/bin:$PATH" NODE_ENV=test \
    node_modules/.bin/vitest run tests/unit/1-core/drivers/codex*.test.ts \
    tests/unit/1-core/drivers/copilot*.test.ts
'
