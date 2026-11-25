#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

target="${1:-}"
if [[ $# -gt 0 ]]; then
    shift
fi
if [[ -n "$target" ]]; then
    set -- --target "$target" "$@"
fi
if [[ "${HYPERNEO_SIGNED_DESKTOP:-0}" != 1 || "${target:-$(rustc --print host-tuple)}" != *-apple-darwin ]]; then
    exec cargo tauri build "$@"
fi

export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: ARCOBY, LLC (P5R65T296V)}"
bash tests/cua-driver.sh
bash prepare-cua-driver.sh
bash locked-use/compile-guardian.sh src-tauri/binaries/hyperneo-locked-use
bash locked-use/compile-plugin.sh src-tauri/binaries/HyperNeoLockedUse.bundle
signing_dir="$(mktemp -d src-tauri/binaries/signing.XXXXXX)"
trap 'rm -rf "$signing_dir"' EXIT
sidecar="$signing_dir/hyperneo"
bundle_target="${target:-$(rustc --print host-tuple)}"
if [[ "$bundle_target" == universal-apple-darwin ]]; then
    lipo -create src-tauri/binaries/hyperneo-{aarch64,x86_64}-apple-darwin -output "$sidecar"
else
    cp -X "src-tauri/binaries/hyperneo-$bundle_target" "$sidecar"
fi
bash sign-cua-driver.sh "$sidecar"
[[ -n "${APPLE_DESKTOP_PROVISIONING_PROFILE:-}" ]] || {
    echo "APPLE_DESKTOP_PROVISIONING_PROFILE is required for signed Desktop builds" >&2
    exit 1
}
printf '%s' "$APPLE_DESKTOP_PROVISIONING_PROFILE" | base64 -D > src-tauri/embedded.provisionprofile

# Tauri signs externalBin entries with the app's entitlements. A custom file
# keeps the daemon's signature when Tauri signs the enclosing app and makes the DMG.
signing_config="{\"bundle\":{\"externalBin\":[],\"macOS\":{\"files\":{\"MacOS/hyperneo\":\"${sidecar#src-tauri/}\"}}}}"
cargo tauri build --config cua-driver-bundle.json --config "$signing_config" "$@"
bash verify-macos-bundle.sh "${CARGO_TARGET_DIR:-src-tauri/target}/${target:+$target/}release/bundle/macos/HyperNeo.app"
