#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT
clang -fobjc-arc -Wall -Werror -framework AppKit -framework ApplicationServices \
    -framework IOKit -framework Security -o "$run/check-release" check-release.m

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
echo 'guardian release check PASS (5 cases)'
