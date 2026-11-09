#!/bin/bash
set -euo pipefail

app="$1"
driver="$app/Contents/MacOS/cua-driver"
requirement='anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

verify_signature() {
    codesign --verify --strict --test-requirement "=$requirement" "$1" &&
        codesign --display --verbose=2 "$1" 2>&1 | grep 'flags=.*(runtime)' >/dev/null
}

if ! verify_signature "$driver"; then
    echo "cua-driver signature verification failed" >&2
    exit 1
fi
verify_signature "$app"
codesign --verify --deep --strict "$app"
xcrun stapler validate "$app"
