#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT
clang -fobjc-arc -Wall -Werror -framework AppKit -framework ApplicationServices \
    -framework IOKit -framework Security -o "$run/check-release" check-release.m

check() {
    local expected="$1" result
    shift
    result="$("$run/check-release" "$@")"
    printf '%s\n' "$result"
    [[ "$result" == "$expected" ]]
}

check $'unlock observed\nlock requested\nrelock observed\nended stopped' delayed
check $'lock requested\nended stopped' capped
check $'allow_answered\ngrant allowed\ngrant refused after allow\ngrant refused after owner input' grant
echo 'guardian release check PASS (3 cases)'
