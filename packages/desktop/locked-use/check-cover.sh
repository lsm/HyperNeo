#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT
clang -fobjc-arc -Wall -Werror -framework AppKit -framework ApplicationServices \
    -framework IOKit -framework Security -framework ImageIO -o "$run/check-cover" check-cover.m

check() {
    local mode="$1" expected="$2" status=0
    "$run/check-cover" "$mode" > "$run/$mode.log" 2>&1 || status=$?
    cat "$run/$mode.log"
    printf 'guardian cover %s exit=%d\n' "$mode" "$status"
    [[ "$status" == 0 ]] && ! grep -qE 'file:|/(System|Library|Users)/|invalid image' "$run/$mode.log" \
        && diff -u <(if [[ -n "$expected" ]]; then printf '%s\n' "$expected"; fi) \
        <(sed -nE '/^(covered|relocked|ended)( |$)/p' "$run/$mode.log")
}

failures=0
check frames $'covered 2\ncovered 2' || failures=$((failures + 1))
check mismatch $'covered 2\nrelocked\nended cover_mismatch' || failures=$((failures + 1))
check paths '' || failures=$((failures + 1))
check displays $'covered 2\ncovered 2' || failures=$((failures + 1))
check late 'covered 2' || failures=$((failures + 1))
check replaced $'covered 2\ncovered 2' || failures=$((failures + 1))
check ending $'covered 2\nrelocked\nended stopped' || failures=$((failures + 1))
printf 'guardian cover check cases=7 failures=%d\n' "$failures"
[[ "$failures" == 0 ]] || exit 1

if [[ "$#" == 2 ]]; then
    "$run/check-cover" render "$1" "$2"
fi
