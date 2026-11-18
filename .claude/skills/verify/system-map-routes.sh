#!/usr/bin/env bash
set -euo pipefail
run=$(mktemp -d)
trap 'rm -rf "$run"' EXIT
export HOME="$run" NODE_ENV=test
output=$(bun run system-map routes packages/web/src/neo/neo-file-question.ts neoFileQuestionText)
printf '%s\n' "$output"
printf '%s\n' "$output" | rg -q 'neo-file-question-text.*text.*path'
printf '%s\n' "$output" | rg -q 'inputs: "path".*outputs: "reference"'
printf '%s\n' "$output" | rg -q 'inputs: \["text","reference"\].*outputs: "text"'
if bun run system-map routes packages/web/src/neo/neo-file-question.ts missing > "$run/missing" 2>&1; then
  exit 1
fi
rg 'not describable:' "$run/missing"
bun run system-map routes list > "$run/list"
rg 'packages/web/src/neo/neo-file-question.ts neoFileQuestionText' "$run/list"
tail -1 "$run/list"
printf 'route proof: passed\n'
