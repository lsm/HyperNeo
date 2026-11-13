#!/bin/bash
set -euo pipefail

tag=hyperneo-cua-driver-v0.44.0-1
commit=3d680c2f659f4eddef76c5690c7311faede07aac
name=hyperneo-cua-driver-0.44.0-1-darwin-universal
requirement='identifier "io.hyperneo.app" and anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
output="$(mkdir -p "${1:?Usage: build-cua-driver.sh <output-dir>}" && cd "$1" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone -q --filter=blob:none --no-checkout --depth 1 --branch "$tag" \
    https://github.com/lsm/cua.git "$work/src"
if [[ "$(git -C "$work/src" rev-parse HEAD)" != "$commit" ]]; then
    echo "$tag does not point at $commit" >&2
    exit 1
fi
git -C "$work/src" sparse-checkout set libs/cua-driver libs/cua libs/images
git -C "$work/src" checkout -q "$commit"

rust="$work/src/libs/cua-driver/rust"
for target in aarch64-apple-darwin x86_64-apple-darwin; do
    (cd "$rust" && env CUA_DRIVER_EMBEDDED_PARENT_REQUIREMENT="$requirement" \
        MACOSX_DEPLOYMENT_TARGET=13.0 \
        RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$work=/build" \
        cargo build --locked -p cua-driver --release --target "$target")
done
mkdir "$work/$name"
lipo -create -output "$work/$name/cua-driver" \
    "$rust/target/aarch64-apple-darwin/release/cua-driver" \
    "$rust/target/x86_64-apple-darwin/release/cua-driver"
install -m 644 "$work/src/LICENSE.md" "$work/$name/LICENSE"
install -m 644 "$rust/THIRD_PARTY_NOTICES.md" "$work/$name/THIRD_PARTY_NOTICES.md"
tar -czf "$output/$name.tar.gz" -C "$work" "$name"
shasum -a 256 "$work/$name/cua-driver" "$output/$name.tar.gz"
