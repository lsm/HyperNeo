#!/bin/bash
# Exits 0 only when every architecture slice of the code at $1 is signed with the hardened runtime.
set -euo pipefail
code="${1:?code path}"
binary="$code"
if [[ -d "$code" ]]; then
    binary="$code/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$code/Contents/Info.plist")"
fi
archs="$(lipo -archs "$binary")"
[[ -n "$archs" ]]
for arch in $archs; do
    codesign --display --verbose=2 --arch "$arch" "$code" 2>&1 | grep -E 'flags=0x[0-9a-f]+\([^)]*runtime' >/dev/null
done
