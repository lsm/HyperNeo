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

check $'unlock observed\nlock requested\nended stopped' delayed
check $'lock requested\nended stopped' capped
echo 'guardian release check PASS (2 cases)'
