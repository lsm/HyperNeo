#!/usr/bin/env bash
set -euo pipefail

base=$1
head=$2
fork=$(git merge-base "$base" "$head")
git diff --name-only --no-renames -z "$fork" "$head" --
