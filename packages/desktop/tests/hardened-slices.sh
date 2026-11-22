#!/bin/bash
# Real codesign and lipo on ad hoc signed universal fixtures: every slice must carry the runtime flag.
set -uo pipefail
desktop="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
printf 'int main(void) { return 0; }\n' > "$fixture/main.c"

universal() {
    local out="$1" arm_runtime="$2" intel_runtime="$3"
    clang -arch arm64 -o "$fixture/arm64" "$fixture/main.c"
    clang -arch x86_64 -o "$fixture/x86_64" "$fixture/main.c"
    codesign --force --sign - ${arm_runtime:+--options runtime} "$fixture/arm64" 2>/dev/null
    codesign --force --sign - ${intel_runtime:+--options runtime} "$fixture/x86_64" 2>/dev/null
    lipo -create "$fixture/arm64" "$fixture/x86_64" -output "$out"
}

bundle() {
    local out="$1"
    mkdir -p "$out/Contents/MacOS"
    printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>main</string><key>CFBundleIdentifier</key><string>fixture</string></dict></plist>\n' > "$out/Contents/Info.plist"
    clang -arch arm64 -arch x86_64 -bundle -o "$out/Contents/MacOS/main" "$fixture/main.c"
    codesign --force --sign - --options runtime "$out" 2>/dev/null
}

failed=0
check() {
    local name="$1" want="$2" code="$3" status=0
    bash "$desktop/hardened-slices.sh" "$code" 2>/dev/null || status=1
    if [[ "$status" == "$want" ]]; then printf 'PASS: %s\n' "$name"; else printf 'FAIL: %s\n' "$name" >&2; failed=1; fi
}

universal "$fixture/both" 1 1
check 'accepts a universal binary hardened on both slices' 0 "$fixture/both"
universal "$fixture/arm-only" 1 ''
check 'refuses a universal binary not hardened on x86_64' 1 "$fixture/arm-only"
universal "$fixture/intel-only" '' 1
check 'refuses a universal binary not hardened on arm64' 1 "$fixture/intel-only"
bundle "$fixture/Plugin.bundle"
check 'accepts a hardened universal bundle' 0 "$fixture/Plugin.bundle"
cp "$fixture/arm-only" "$fixture/Plugin.bundle/Contents/MacOS/main"
check 'refuses a bundle whose executable is not hardened on x86_64' 1 "$fixture/Plugin.bundle"
exit "$failed"
