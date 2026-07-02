#!/bin/bash
# Build script for the neokai sidecar binary.
#
# Compiles the daemon into a single bun binary and copies it into
# packages/desktop/src-tauri/binaries/neokai-<host-target-triple>{.exe?}
# where Tauri's `externalBin` picks it up.
#
# This must be run before `cargo tauri build` (the `build` script wires it up).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Monorepo root is two levels up from packages/desktop.
HYPERNEO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BINARIES_DIR="$SCRIPT_DIR/src-tauri/binaries"

# Get the current platform target triple
TARGET=$(rustc --print host-tuple)
echo "Target triple: $TARGET"

# Map rust target to bun target (matches scripts/build-binary.ts ALL_TARGETS).
case "$TARGET" in
	"aarch64-apple-darwin")
		BUN_TARGET="bun-darwin-arm64"
		;;
	"x86_64-apple-darwin")
		BUN_TARGET="bun-darwin-x64"
		;;
	"x86_64-pc-windows-msvc")
		BUN_TARGET="bun-windows-x64"
		EXT=".exe"
		;;
	"x86_64-unknown-linux-gnu")
		BUN_TARGET="bun-linux-x64"
		;;
	"aarch64-unknown-linux-gnu")
		BUN_TARGET="bun-linux-arm64"
		;;
	*)
		echo "Unsupported target: $TARGET"
		exit 1
		;;
esac

echo "Building neokai for $BUN_TARGET..."

# Build the neokai binary using the existing monorepo pipeline.
cd "$HYPERNEO_DIR"
bun run scripts/build-binary.ts --target "$BUN_TARGET"

# Create binaries directory
mkdir -p "$BINARIES_DIR"

# Copy and rename the binary so Tauri's externalBin can find it.
SOURCE="$HYPERNEO_DIR/dist/bin/hyperneo-${BUN_TARGET#bun-}${EXT:-}"
DEST="$BINARIES_DIR/neokai-$TARGET${EXT:-}"

cp "$SOURCE" "$DEST"
chmod +x "$DEST"

echo "Sidecar binary built: $DEST"
ls -lh "$DEST"
