#!/bin/bash
set -euo pipefail

app="$1"
driver="$app/Contents/MacOS/cua-driver"
requirement='anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

verify_signature() {
    codesign --verify --strict --test-requirement "=$requirement${2:-}" "$1" &&
        codesign --display --verbose=2 "$1" 2>&1 | grep 'flags=.*(runtime)' >/dev/null
}

if ! verify_signature "$driver" ' and identifier "cua-driver"'; then
    echo "cua-driver signature verification failed" >&2
    exit 1
fi
entitlements="$(mktemp)"
trap 'rm -f "$entitlements"' EXIT
codesign --display --entitlements - --xml "$driver" > "$entitlements"
cat "$entitlements"
for key in com.apple.security.automation.apple-events com.apple.security.device.screen-capture; do
    if [[ "$(/usr/libexec/PlistBuddy -c "Print :$key" "$entitlements" 2>/dev/null)" != true ]]; then
        echo "cua-driver entitlement missing: $key" >&2
        exit 1
    fi
done

if [[ "${2:-}" == --driver-only ]]; then exit 0; fi

verify_signature "$app"
codesign --display --entitlements - --xml "$app" | grep -q '<string>P5R65T296V.io.hyperneo.app</string>' &&
    security cms -D -i "$app/Contents/embedded.provisionprofile" >/dev/null || {
    echo "app keychain access group or provisioning profile missing" >&2
    exit 1
}
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
