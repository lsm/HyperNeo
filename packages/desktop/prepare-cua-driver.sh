#!/bin/bash
set -euo pipefail

release=hyperneo-cua-driver-v0.44.0-1
archive=hyperneo-cua-driver-0.44.0-1-darwin-universal
archive_sha256=abb0bea595b80b095fb2b20e91f2c2ffca73f736a6e7df6c931bba333151975d
driver_sha256=8efa276026a3bd7e5117da2e18891309314f32734ada4ece116665c498b63b06

verify_driver() {
    local driver="$1" digest
    digest="$(shasum -a 256 "$driver")"
    if [[ "${digest%% *}" != "$driver_sha256" ]]; then
        echo "cua-driver SHA-256 mismatch" >&2
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
    "https://github.com/lsm/cua/releases/download/${release}/${archive}.tar.gz"
printf '%s  %s\n' "$archive_sha256" "$staging/driver.tgz" | shasum -a 256 --check

tar -xzf "$staging/driver.tgz" -C "$staging" \
    "$archive/cua-driver" "$archive/LICENSE" "$archive/THIRD_PARTY_NOTICES.md"
source_dir="$staging/$archive"
verify_driver "$source_dir/cua-driver"

mkdir -p "$binaries"
install -m 755 "$source_dir/cua-driver" "$binaries/cua-driver"
install -m 644 "$source_dir/LICENSE" "$binaries/cua-driver-LICENSE"
install -m 644 "$source_dir/THIRD_PARTY_NOTICES.md" "$binaries/cua-driver-THIRD_PARTY_NOTICES.md"
