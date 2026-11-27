#!/bin/bash
# Builds the unsigned guardian as the app $1, so macOS privacy settings show it as
# "HyperNeo Locked Use" with the HyperNeo icon. The caller signs it as io.hyperneo.locked-use.
set -euo pipefail
app="${1:?output app}"
[[ "$app" == /* ]] || app="$PWD/$app"
cd "$(dirname "$0")"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp GuardianInfo.plist "$app/Contents/Info.plist"
cp ../src-tauri/icons/icon.icns "$app/Contents/Resources/icon.icns"
bash compile-guardian.sh "$app/Contents/MacOS/hyperneo-locked-use"
