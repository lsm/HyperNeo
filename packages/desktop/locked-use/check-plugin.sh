#!/bin/bash
# Checks that the plugin grants only to a server signed as the HyperNeo guardian.
# Needs no root and no lock. Usage: check-plugin.sh <build dir from build.sh>
set -euo pipefail
cd "$(dirname "$0")"
out="$(cd "${1:?build directory}" && pwd)"
identity="${APPLE_SIGNING_IDENTITY:-Developer ID Application: ARCOBY, LLC (P5R65T296V)}"
plugin="$out/HyperNeoLockedUse.bundle/Contents/MacOS/HyperNeoLockedUse"
clang -O2 -Wall -Werror -o "$out/check-plugin" check-plugin.c
for name in adhoc other guardian; do cp "$out/check-plugin" "$out/serve-$name"; done
codesign --force --sign - "$out/serve-adhoc"
codesign --force --sign "$identity" --options runtime --identifier io.hyperneo.other "$out/serve-other"
codesign --force --sign "$identity" --options runtime --identifier io.hyperneo.locked-use "$out/serve-guardian"

ask() {
    local server="$1" expected="$2" mode="${3:-answer}" got
    local pid=""
    if [[ -n "$server" ]]; then
        "$out/serve-$server" serve "$mode" > "$out/serve.log" &
        pid=$!
        for _ in $(seq 50); do grep -q serving "$out/serve.log" 2>/dev/null && break; sleep 0.05; done
    fi
    got="$("$out/check-plugin" ask "$plugin" || echo crashed)"
    [[ -n "$pid" ]] && { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
    echo "${server:-none}${3:+-$3}=$got"
    [[ "$got" == "$expected" ]]
}
ask "" deny
ask adhoc deny
ask other deny
ask guardian deny silent
ask guardian deny hangup
ask guardian allow
echo "plugin check PASS"
