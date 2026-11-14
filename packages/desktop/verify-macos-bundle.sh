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
trap 'rm -f "$entitlements" "$entitlements.profile"' EXIT
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
codesign --display --entitlements - --xml "$app" > "$entitlements"
security cms -D -i "$app/Contents/embedded.provisionprofile" > "$entitlements.profile"
group="$(/usr/libexec/PlistBuddy -c 'Print :keychain-access-groups:0' "$entitlements" 2>/dev/null)"
allowed="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:keychain-access-groups:0' "$entitlements.profile" 2>/dev/null)"
if [[ "$group" != P5R65T296V.io.hyperneo.app || "$allowed" != P5R65T296V.\* ]]; then
    echo "app keychain access group or provisioning profile missing" >&2
    exit 1
fi
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
