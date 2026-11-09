#!/bin/bash
set -euo pipefail
set +x
cd "$(dirname "$0")"

identity="$APPLE_SIGNING_IDENTITY"
keychain_args=()
if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
    signing_dir="$(mktemp -d)"
    keychain="$signing_dir/cua-signing.keychain-db"
    trap 'security delete-keychain "$keychain" >/dev/null 2>&1 || true; rm -rf "$signing_dir"' EXIT
    keychain_password="$(openssl rand -hex 24)"
    current_keychains="$(security list-keychains -d user)"
    security create-keychain -p "$keychain_password" "$keychain"
    security unlock-keychain -p "$keychain_password" "$keychain"
    base64 -D > "$signing_dir/certificate.p12" <<< "$APPLE_CERTIFICATE"
    security import "$signing_dir/certificate.p12" -k "$keychain" -f pkcs12 -t agg \
        -P "${APPLE_CERTIFICATE_PASSWORD:?}" -T /usr/bin/codesign >/dev/null
    security set-keychain-settings -t 3600 -u "$keychain"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
        -k "$keychain_password" "$keychain" >/dev/null

    keychains=("$keychain")
    while IFS= read -r entry; do
        [[ -n "$entry" ]] && keychains+=("$entry")
    done < <(sed -nE 's/^[[:space:]]*"([^"]+)"$/\1/p' <<< "$current_keychains")
    security list-keychains -d user -s "${keychains[@]}"
    identity="$(security find-identity -v -p codesigning "$keychain" |
        sed -nE 's/^[[:space:]]*[0-9]+\) [[:xdigit:]]+ "(Developer ID Application: .* \(P5R65T296V\))"$/\1/p' |
        sort -u)"
    if [[ -z "$identity" || "$identity" == *$'\n'* ]]; then
        echo "Expected one Developer ID Application identity for team P5R65T296V" >&2
        exit 1
    fi
    keychain_args=(--keychain "$keychain")
fi

codesign --force --sign "$identity" ${keychain_args[@]+"${keychain_args[@]}"} \
    --timestamp --options runtime --identifier cua-driver \
    --entitlements src-tauri/CuaDriverEntitlements.plist src-tauri/binaries/cua-driver
