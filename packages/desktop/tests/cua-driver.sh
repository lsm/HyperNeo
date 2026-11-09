#!/bin/bash
set -euo pipefail

desktop="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

refuses() {
    local name="$1" expected="$2" output
    shift 2
    if output=$("$@" 2>&1) || [[ "$output" != *"$expected"* ]]; then
        printf 'FAIL: %s\n%s\n' "$name" "$output" >&2
        return 1
    fi
    printf 'PASS: %s\n' "$name"
}

mkdir -p "$fixture/HyperNeo.app/Contents/MacOS"
driver="$fixture/HyperNeo.app/Contents/MacOS/cua-driver"
printf '#!/bin/sh\necho "cua-driver 0.44.0"\n' > "$driver"
chmod +x "$driver"

failed=0
refuses 'refuses a bundled driver that fails the pin' 'cua-driver SHA-256 mismatch' \
    bash "$desktop/prepare-cua-driver.sh" --verify "$driver" || failed=1
refuses 'refuses a bundle whose nested driver is unsigned' 'cua-driver signature verification failed' \
    bash "$desktop/verify-macos-bundle.sh" "$fixture/HyperNeo.app" || failed=1
mkdir "$fixture/bin"
cat > "$fixture/bin/codesign" <<'CODESIGN'
#!/bin/bash
case "$1:$2" in
    --verify:*) exit 0 ;;
    --display:--verbose=2) echo 'CodeDirectory flags=0x10000(runtime)' ;;
    --display:--entitlements)
        cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.automation.apple-events</key><true/>
</dict></plist>
PLIST
        ;;
    *) exit 2 ;;
esac
CODESIGN
chmod +x "$fixture/bin/codesign"
cat > "$fixture/bin/xcrun" <<'XCRUN'
#!/bin/bash
exit 0
XCRUN
chmod +x "$fixture/bin/xcrun"

refuses 'refuses a signed driver missing required entitlements' 'cua-driver entitlement missing: com.apple.security.device.screen-capture' \
    env PATH="$fixture/bin:$PATH" bash "$desktop/verify-macos-bundle.sh" "$fixture/HyperNeo.app" || failed=1
exit "$failed"
