#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT
clang -fobjc-arc -Wall -Werror -framework AppKit -framework ApplicationServices \
    -framework IOKit -framework Security -framework ImageIO -o "$run/check-release" check-release.m

check() {
    local expected_status="$1" expected="$2" result status=0
    shift 2
    result="$("$run/check-release" "$@")" || status=$?
    printf '%s\n' "$result"
    [[ "$status" == "$expected_status" && "$result" == "$expected" ]]
}

check 0 $'owner_input\nlock requested\nrelock observed\nhandoff interval elapsed\nended local_input' input
check 0 $'unlock observed\nlock requested\nrelock observed\nended stopped' delayed
check 0 $'lock requested\nended stopped' capped
check 3 $'lock requested\nended stopped relock_failed' relock_failed
check 0 $'allow_answered\ngrant allowed\ngrant refused after allow\ngrant refused after owner input' grant
check 0 $'opaque through hold\nboth displays fading\nlock requested\nrestored immediately on unlock\nopaque through fresh hold\nended stopped\nexit opacity 0 on both displays' fade-relock
check 0 $'opaque when remaining time is less than fade duration\nended stopped\nexit opacity 1 on both displays' fade-skipped
check 0 $'both displays fading before deadline\nended stopped\nexit opacity 1 on both displays' fade-deadline-locked
check 3 $'both displays fading before deadline\nended stopped relock_failed\nexit opacity 1 on both displays' fade-deadline-unlocked
echo 'guardian release check PASS (9 cases)'
