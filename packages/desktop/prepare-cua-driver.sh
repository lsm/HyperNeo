#!/bin/bash
set -euo pipefail

version=0.44.0
archive="cua-driver-rs-${version}-darwin-universal"
archive_sha256=7699d7ebd3d3319cbd066af9fc679dc7439adad6c5c84cc46956aa9880106e37
driver_sha256=ac358aeff2de92baca3cffcc5486fc10c3618ec62c9bba56b7a8f7a606c2ca5c

verify_driver() {
    local driver="$1" digest
    digest="$(shasum -a 256 "$driver")"
    if [[ "${digest%% *}" != "$driver_sha256" ]]; then
        echo "cua-driver SHA-256 mismatch" >&2
        return 1
    fi
    if [[ "$("$driver" --version)" != "cua-driver $version" ]]; then
        echo "cua-driver version mismatch" >&2
        return 1
    fi
}

if [[ "${1:-}" == "--verify" ]]; then
    verify_driver "$2"
    exit
fi

binaries="$(cd "$(dirname "$0")" && pwd)/src-tauri/binaries"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
curl -fsSL --retry 3 --retry-all-errors -o "$staging/driver.tgz" \
    "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${archive}.tar.gz"
printf '%s  %s\n' "$archive_sha256" "$staging/driver.tgz" | shasum -a 256 --check

tar -xzf "$staging/driver.tgz" -C "$staging" \
    "$archive/cua-driver" "$archive/LICENSE" "$archive/THIRD_PARTY_NOTICES.md"
source_dir="$staging/$archive"
verify_driver "$source_dir/cua-driver"

mkdir -p "$binaries"
install -m 755 "$source_dir/cua-driver" "$binaries/cua-driver"
install -m 644 "$source_dir/LICENSE" "$binaries/cua-driver-LICENSE"
install -m 644 "$source_dir/THIRD_PARTY_NOTICES.md" "$binaries/cua-driver-THIRD_PARTY_NOTICES.md"
