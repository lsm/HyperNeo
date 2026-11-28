#!/usr/bin/env bash
set -euo pipefail

evidence=${1:?Supply an evidence directory}
base=$(git rev-parse --verify "${2:-origin/dev}^{commit}")
head=$(git rev-parse --verify HEAD)
tree=$(git merge-tree --write-tree "$base" "$head")
merge=$(git commit-tree "$tree" -p "$base" -p "$head" -m 'System map Verify merge fixture')
mkdir -p "$evidence"
bash scripts/system-map-diff.sh "$base" "$merge" > "$evidence/paths"
bun scripts/system-map-impact.ts --print "$base" > "$evidence/attestation.md"

write_event() {
  jq -n --arg head "$head" --arg base "$base" --arg body "$1" '
    {pull_request: {head: {sha: $head}, base: {sha: $base}, body: $body, labels: []}}
  ' > "$evidence/event.json"
}
check() {
  GITHUB_ACTIONS=true bun scripts/system-map-impact.ts --check "$evidence/event.json" "$evidence/paths"
}

write_event ''
missing=0
check > "$evidence/missing.log" 2>&1 || missing=$?
[[ "$missing" = 1 ]]
grep -F '::error::System map check failed:' "$evidence/missing.log"
! grep -E 'reason; head|"(head|base)":' "$evidence/missing.log" "$evidence/attestation.md"

write_event "$(cat "${3:-$evidence/attestation.md}")"
check > "$evidence/current.log" 2>&1
for expected in '::group::System map on ' 'Base impact' 'Head impact' '```system-map-impact'; do
  grep -F -- "$expected" "$evidence/current.log" > /dev/null
done

paths=$(tr -cd '\000' < "$evidence/paths" | wc -c | tr -d ' ')
entries=$(awk 'END {print NR - 3}' "$evidence/attestation.md")
printf 'missing exit=%s current exit=0 changed paths=%s required entries=%s\n' "$missing" "$paths" "$entries"
