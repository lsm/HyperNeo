#!/usr/bin/env bash
set -euo pipefail

base=$1
merge=$2
if [[ "$(git rev-parse "$merge^1")" != "$base" ]]; then
  printf 'Merge %s first parent does not match event base %s\n' "$merge" "$base" >&2
  exit 1
fi
git diff --name-only --no-renames -z "$base" "$merge" --
