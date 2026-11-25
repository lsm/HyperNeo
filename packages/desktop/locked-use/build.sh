#!/bin/bash
# Builds and signs the Locked Use authorization plugin and guardian into $1.
set -euo pipefail
cd "$(dirname "$0")"
out="${1:?output directory}"
identity="${APPLE_SIGNING_IDENTITY:-Developer ID Application: ARCOBY, LLC (P5R65T296V)}"
bundle="$out/HyperNeoLockedUse.bundle"
bash compile-plugin.sh "$bundle"
bash compile-guardian.sh "$out/hyperneo-locked-use"
codesign --force --sign "$identity" --timestamp --options runtime "$bundle"
codesign --force --sign "$identity" --timestamp --options runtime \
    --identifier io.hyperneo.locked-use "$out/hyperneo-locked-use"
codesign --verify --strict "$bundle" "$out/hyperneo-locked-use"
