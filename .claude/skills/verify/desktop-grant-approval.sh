#!/bin/bash
# Usage: APPLE_SIGNING_IDENTITY=<name or SHA-1> desktop-grant-approval.sh <evidence-dir> <profile>
# Signs the fixture host as io.hyperneo.app with the Developer ID profile and
# runs the grant and owner-approval tests against the real keychain group.
set -euo pipefail
out=$(mkdir -p "$1" && cd "$1" && pwd)
profile=$2
root=$(git rev-parse --show-toplevel)
host="$root/packages/desktop/tests/driver-host"
cargo rustc --locked --manifest-path "$host/Cargo.toml" --bin desktop-driver-fixture -- --cfg test
app="$out/HyperNeoGrantFixture.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$host/target/debug/desktop-driver-fixture" "$app/Contents/MacOS/"
cp "$profile" "$app/Contents/embedded.provisionprofile"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>desktop-driver-fixture</string><key>CFBundleIdentifier</key><string>io.hyperneo.app</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
codesign -f -s "$APPLE_SIGNING_IDENTITY" -o runtime -i io.hyperneo.app \
    --entitlements "$root/packages/desktop/src-tauri/SignedEntitlements.plist" "$app"
"$app/Contents/MacOS/desktop-driver-fixture" >/dev/null 2>&1 || true
python3 "$root/packages/desktop/tests/worker-drivers.py" "$app/Contents/MacOS/desktop-driver-fixture" \
    -k grant -k answer -k owner_yes 2>&1 | tee "$out/grant-approval.txt"
exit "${PIPESTATUS[0]}"
