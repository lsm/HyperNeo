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
bash sign-cua-driver.sh
[[ -n "${APPLE_DESKTOP_PROVISIONING_PROFILE:-}" ]] || {
    echo "APPLE_DESKTOP_PROVISIONING_PROFILE is required for signed Desktop builds" >&2
    exit 1
}
printf '%s' "$APPLE_DESKTOP_PROVISIONING_PROFILE" | base64 -D > src-tauri/embedded.provisionprofile
cargo tauri build --config cua-driver-bundle.json "$@"
bash verify-macos-bundle.sh "${CARGO_TARGET_DIR:-src-tauri/target}/${target:+$target/}release/bundle/macos/HyperNeo.app"
