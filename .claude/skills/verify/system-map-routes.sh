#!/usr/bin/env bash
set -euo pipefail
bun .claude/skills/verify/system-map-inline.ts
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
bun scripts/pipeline-verdict-report.ts --strict > "$run/verdicts.json"
echo 'strict report exit=0'
bun scripts/pipeline-verdict-report.ts > "$run/regular-verdicts.json"
jq -e '[.[] | select(.name == "work.health" and .verdict == "named")] | length == 1' "$run/regular-verdicts.json"
jq -er '
  [
    "evolution.scope.owner.set",
    "goal.owner.set",
    "space.audit.list",
    "gmail.search",
    "google.accounts",
    "work.queue",
    "work.withdraw"
  ] as $expected
  | [.[] | .name as $name | select($expected | index($name))] as $routes
  | ($routes[] | [.name, .verdict] | @tsv),
    ("matched routes: " + ($routes | length | tostring)),
    (($routes | map(.name) | sort) == ($expected | sort)
      and ($routes | all(.verdict == "named")))
' "$run/verdicts.json"
printf 'route proof: passed\n'
