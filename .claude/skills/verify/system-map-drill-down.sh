#!/usr/bin/env bash
set -euo pipefail

output=${1:?Usage: bash .claude/skills/verify/system-map-drill-down.sh OUTPUT_DIR DIFF_BASE}
base=${2:?Provide a diff base that changes a publication operation}
mkdir -p "$output"

bun scripts/pipeline-verdict-report.ts --strict > "$output/verdicts.json"
bun scripts/system-map.ts map > "$output/map.md"
bun scripts/system-map.ts map --diff "$base" > "$output/map-diff.md"
bun scripts/system-map.ts where space.list > "$output/where.txt"

summary=$(jq -r '"# System map — \(length) routes, \(map(select(.verdict == "named")) | length) named, \(map(select(.verdict == "unreadable")) | length) unreadable"' "$output/verdicts.json")
routes=$(jq length "$output/verdicts.json")
for map in "$output/map.md" "$output/map-diff.md"; do
  [[ $(head -n 1 "$map") == "$summary" ]]
  [[ $(awk '/^- `/ { count++ } END { print count+0 }' "$map") == "$routes" ]]
  sed -n 's/^- \[.*\](#\([a-z0-9_]*\)) — .*/\1/p' "$map" > "$output/links.txt"
  sed -n 's/^<a id="\([a-z0-9_]*\)"><\/a>$/\1/p' "$map" > "$output/anchors.txt"
  cmp "$output/links.txt" "$output/anchors.txt"
  sections=$(awk 'END { print NR }' "$output/anchors.txt")
  [[ "$sections" -gt 0 && $(sort -u "$output/anchors.txt" | awk 'END { print NR }') == "$sections" ]]
  printf '%s — %s unique linked components\n' "$(basename "$map")" "$sections"
done

rg -F '[space/](#space_2f) — ' "$output/map.md"
rg -F 'op space.list  defines  packages/space/src/space-read-operations.ts' "$output/where.txt"
rg -F '[daemon/neo](#daemon_2fneo) — ' "$output/map-diff.md" | rg -F '(touched)'
for route in publish read; do
  rg -F -- "- \`neo.publication.$route\` (touched) — " "$output/map-diff.md"
done
rg '^- `neo\.project\.save` — ' "$output/map-diff.md"
printf '%s\n' "$summary"
