#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT
clang -fobjc-arc -Wall -Werror -framework AppKit -framework ApplicationServices \
    -framework IOKit -framework Security -o "$run/check-cover" check-cover.m

check() {
    local mode="$1" expected="$2" status=0
    "$run/check-cover" "$mode" > "$run/$mode.log" || status=$?
    cat "$run/$mode.log"
    printf 'guardian cover %s exit=%d\n' "$mode" "$status"
    [[ "$status" == 0 ]] && diff -u <(printf '%s\n' "$expected") \
        <(sed -nE '/^(covered|relocked|ended)( |$)/p' "$run/$mode.log")
}

failures=0
check frames $'covered 2\ncovered 2' || failures=$((failures + 1))
check mismatch $'covered 2\nrelocked\nended cover_mismatch' || failures=$((failures + 1))
printf 'guardian cover check cases=2 failures=%d\n' "$failures"
[[ "$failures" == 0 ]]
