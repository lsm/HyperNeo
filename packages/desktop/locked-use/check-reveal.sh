#!/bin/bash
# Headless check for the guardian's reveal click: while Touch ID can unlock, the login
# window hides its password field, and the guardian must click the prompt label through
# the HID tap to bring it back, without ever mistaking its own click for owner input.
# Compiles the fixture in check-reveal.m against guardian.m and runs five modes.
# It never locks, unlocks or types. Usage: check-reveal.sh
set -euo pipefail
cd "$(dirname "$0")"
run="$(mktemp -d)"
trap 'rm -rf "$run"' EXIT
clang -fobjc-arc -Wall -Werror -framework AppKit -framework ApplicationServices \
    -framework IOKit -framework Security -framework ImageIO -o "$run/check-reveal" check-reveal.m

reveal() {
    local result
    result="$("$run/check-reveal" "$1")"
    printf '%s\n' "$result"
    case "$1" in
    reveal) [[ "$result" == $'click hid 720,530\nsubmitted' ]] ;;
    ambiguous) [[ "$result" != *click* && "$result" == *"prompts=2 reveal=no_prompt"* && "$result" == *$'\nended unlock_failed' ]] ;;
    ignored) [[ "$result" == click* && "$result" != *submitted* && "$result" == *$'\nended unlock_failed' ]] ;;
    input) [[ "$result" != *click* && "$result" == *"reveal=owner_input"* && "$result" == *$'\nended local_input' ]] ;;
    arm) [[ "$result" == $'click hid 720,530\nowner_input'* && "$result" == *"reveal=clicked"* && "$result" != *submitted* && "$result" == *$'\nended local_input' ]] ;;
    esac || { echo "guardian reveal check FAIL ($1)"; exit 1; }
}
for case in reveal ambiguous ignored input arm; do reveal "$case"; done
echo 'guardian reveal check PASS (5 cases)'
