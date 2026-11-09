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

cat > "$fixture/bin/security" <<'SECURITY'
#!/bin/bash
case "$*" in
    'list-keychains -d user')
        printf '    "/fixture/first keychain"\n    "/fixture/second keychain"\n'
        ;;
    'list-keychains -d user -s /fixture/first keychain /fixture/second keychain')
        echo restore >> "$SIGNING_TRACE"
        ;;
    'list-keychains -d user -s '*)
        [[ "$#" == 7 && "$5" == */cua-signing.keychain-db &&
            "$6" == '/fixture/first keychain' && "$7" == '/fixture/second keychain' ]] || exit 2
        echo prepend >> "$SIGNING_TRACE"
        ;;
    'find-identity -v -p codesigning '*)
        echo '  1) 0000 "Developer ID Application: Fixture (P5R65T296V)"'
        ;;
    'delete-keychain '*)
        echo delete >> "$SIGNING_TRACE"
        ;;
esac
SECURITY
cat > "$fixture/bin/codesign" <<'CODESIGN'
#!/bin/bash
echo sign >> "$SIGNING_TRACE"
exit 23
CODESIGN
chmod +x "$fixture/bin/security" "$fixture/bin/codesign"

status=0
env PATH="$fixture/bin:$PATH" SIGNING_TRACE="$fixture/trace" \
    APPLE_SIGNING_IDENTITY=fixture APPLE_CERTIFICATE=Zml4dHVyZQ== APPLE_CERTIFICATE_PASSWORD=fixture \
    bash "$desktop/sign-cua-driver.sh" || status=$?
if [[ "$status" == 23 && "$(cat "$fixture/trace")" == $'prepend\nsign\nrestore\ndelete' ]]; then
    echo 'PASS: restores keychain search order before deletion on signing failure'
else
    echo 'FAIL: restores keychain search order before deletion on signing failure' >&2
    cat "$fixture/trace" >&2
    failed=1
fi
exit "$failed"
