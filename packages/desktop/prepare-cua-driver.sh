#!/bin/bash
set -euo pipefail

release=hyperneo-cua-driver-v0.55.0-1
archive=hyperneo-cua-driver-0.55.0-1-darwin-universal
archive_sha256=454bac022e61d39e6fc1bc7560b2f2af8f24e6675efb7ffcfdcfe12447bcde21
driver_sha256=ea03d77126003144a6c4864633b09ab591414acb32cb2c1dd1e3d8c05c98f341

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
