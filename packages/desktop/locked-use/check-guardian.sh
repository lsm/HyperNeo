#!/bin/bash
# Checks that the guardian starts only under HyperNeo Desktop, only on a locked screen and only
# with Accessibility and Input Monitoring. Run it while the screen is unlocked; it never covers or
# unlocks. The gated copy is signed under a separate identifier and disclaims its launcher, so it
# holds no privacy grants on any Mac. Usage: check-guardian.sh <build dir from build.sh>
set -euo pipefail
cd "$(dirname "$0")"
out="$(cd "${1:?build directory}" && pwd)"
identity="${APPLE_SIGNING_IDENTITY:-Developer ID Application: ARCOBY, LLC (P5R65T296V)}"
clang -O2 -Wall -Werror -o "$out/launch-app" check-launch.c
cp "$out/launch-app" "$out/launch-other"
cp "$out/hyperneo-locked-use" "$out/ungranted-guardian"
codesign --force --sign "$identity" --options runtime --identifier io.hyperneo.app "$out/launch-app"
codesign --force --sign "$identity" --options runtime --identifier io.hyperneo.other "$out/launch-other"
codesign --force --sign "$identity" --options runtime --identifier io.hyperneo.locked-use.check "$out/ungranted-guardian"
if security authorizationdb read system.login.screensaver 2>/dev/null | grep -q io.hyperneo.locked-use.unlock; then
    installed=""
else
    installed="not_installed "
fi

start() {
    local expected="$1" got
    shift
    got="$("$@" < /dev/null || true)"
    echo "$got"
    [[ "$got" == "ended $expected" ]]
}
start untrusted_owner "$out/hyperneo-locked-use"
start untrusted_owner "$out/launch-other" "$out/hyperneo-locked-use"
start "${installed}not_locked accessibility_required input_monitoring_required" \
    "$out/launch-app" --disclaim "$out/ungranted-guardian"
echo "guardian check PASS"
