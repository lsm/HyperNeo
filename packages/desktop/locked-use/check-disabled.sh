#!/bin/bash
# Exercise the shipped native entry points without installing a rule or touching the GUI.
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT

bash compile-guardian.sh "$run/hyperneo-locked-use"
status=0
result="$("$run/hyperneo-locked-use" 120 </dev/null)" || status=$?
printf 'guardian exit=%s output=%s\n' "$status" "$result"
[[ "$status" == 2 && "$result" == "ended disabled" ]] || exit 1

bundle="$run/HyperNeoLockedUse.bundle"
bash compile-plugin.sh "$bundle"
clang -O2 -Wall -Werror -o "$run/check-plugin" check-plugin.c
result="$("$run/check-plugin" ask "$bundle/Contents/MacOS/HyperNeoLockedUse")"
printf 'authorization mechanism=%s\n' "$result"
[[ "$result" == deny ]] || exit 1

status=0
result="$(bash install.sh "$bundle" 2>&1)" || status=$?
printf 'installer exit=%s output=%s\n' "$status" "$result"
[[ "$status" == 1 && "$result" == "Locked Use is disabled. Use uninstall.sh to restore the macOS unlock rule." ]] || exit 1

echo 'Locked Use disabled: 3 entry points passed'
