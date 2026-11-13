#!/bin/zsh
# Runs the neo.question.ask lock journey in a fresh isolated run directory.
set -u
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
RUN=$(mktemp -d /private/tmp/hn-question-beside-writer-XXXXXX)
mkdir -p "$RUN/home"
cd "$ROOT"
env -i HOME="$RUN/home" PATH="$RUN/bin:$PATH" NODE_ENV=test \
  HYPERNEO_DATA_DIR="$RUN/data" LOG_LEVEL=error \
  bun .claude/skills/verify/neo-question-beside-writer.ts "$RUN"
code=$?
echo "exit=$code run=$RUN"
exit $code
