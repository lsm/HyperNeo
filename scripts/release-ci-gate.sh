#!/usr/bin/env bash
set -euo pipefail
sha=${1:?commit SHA is required}
[[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
if ! runs=$(gh run list --repo "$GITHUB_REPOSITORY" --workflow=main.yml --branch=dev \
  --event=push --commit="$sha" --limit=100 \
  --json databaseId,headSha,headBranch,event,status,conclusion); then
  echo 'Cannot read dev CI runs' >&2
  exit 1
fi
if ! run=$(jq -er --arg sha "$sha" '
  [.[] | select(.headSha == $sha and .headBranch == "dev" and .event == "push")]
  | first | select(.status == "completed" and .conclusion == "success")
  | .databaseId | select(type == "number" and . > 0)
' <<< "$runs"); then
  echo "No completed successful latest dev push CI run for $sha" >&2
  exit 1
fi
echo "Verified dev CI run $run for $sha"
