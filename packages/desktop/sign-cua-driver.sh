#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

signing_args=(--force --sign "$APPLE_SIGNING_IDENTITY" --timestamp --options runtime
    --identifier cua-driver --entitlements src-tauri/CuaDriverEntitlements.plist)

if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
    signing_dir="$(mktemp -d)"
    keychain="$signing_dir/cua-signing.keychain-db"
    trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true; rm -rf "$signing_dir"' EXIT
    keychain_password="$(openssl rand -hex 24)"
    security create-keychain -p "$keychain_password" "$keychain"
    security unlock-keychain -p "$keychain_password" "$keychain"
    base64 -D > "$signing_dir/certificate.p12" <<< "$APPLE_CERTIFICATE"
    security import "$signing_dir/certificate.p12" -k "$keychain" -f pkcs12 \
        -P "${APPLE_CERTIFICATE_PASSWORD:?}" -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
        -k "$keychain_password" "$keychain" >/dev/null
    signing_args+=(--keychain "$keychain")
fi

codesign "${signing_args[@]}" src-tauri/binaries/cua-driver
