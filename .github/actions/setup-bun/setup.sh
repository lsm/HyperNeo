#!/bin/bash
# Setup Bun - Simple bash-based installer with local caching
set -e

BUN_INSTALL="${HOME}/.bun"
BUN_BIN="${BUN_INSTALL}/bin"
BUN_PATH="${BUN_BIN}/bun"
REQUESTED_VERSION="${BUN_VERSION:-latest}"

# Output helper
output() {
    echo "$1=$2" >> "$GITHUB_OUTPUT"
}

# Check if bun exists and get version
get_installed_version() {
    if [[ -x "$BUN_PATH" ]]; then
        "$BUN_PATH" --version 2>/dev/null || echo ""
    fi
}

# Resolve "latest" to actual version
resolve_version() {
    local version="$1"
    if [[ "$version" == "latest" ]]; then
        curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 "https://api.github.com/repos/oven-sh/bun/releases/latest" | grep -oP '"tag_name":\s*"bun-v\K[^"]+' || echo ""
    else
        echo "$version"
    fi
}

# Download and install bun
install_bun() {
    local version="$1"
    echo "Installing Bun v${version}..."

    # Detect architecture
    local arch
    case "$(uname -m)" in
        x86_64)  arch="x64" ;;
        aarch64) arch="aarch64" ;;
        arm64)   arch="aarch64" ;;
        *)       echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
    esac

    # Detect OS
    local os
    case "$(uname -s)" in
        Linux)  os="linux" ;;
        Darwin) os="darwin" ;;
        *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
    esac

    # Check for AVX2 support (Linux x64 only)
    local avx2=""
    if [[ "$os" == "linux" && "$arch" == "x64" ]]; then
        if grep -q avx2 /proc/cpuinfo 2>/dev/null; then
            avx2="true"
        else
            avx2="false"
        fi
    fi

    # Build download URL
    local url="https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-${os}-${arch}"
    if [[ "$avx2" == "false" ]]; then
        url="${url}-baseline"
    fi
    url="${url}.zip"

    # Download and extract
    local tmpdir=$(mktemp -d)
    local zipfile="${tmpdir}/bun.zip"

    echo "Downloading from: $url"
    curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 -o "$zipfile" "$url"

    mkdir -p "$BUN_BIN"
    unzip -o -q "$zipfile" -d "$tmpdir"

    # Find and install the bun binary
    local extracted_bun=$(find "$tmpdir" -name "bun" -type f -executable | head -1)
    if [[ -z "$extracted_bun" ]]; then
        extracted_bun=$(find "$tmpdir" -name "bun" -type f | head -1)
    fi

    if [[ -z "$extracted_bun" ]]; then
        echo "Error: Could not find bun binary in archive"
        exit 1
    fi

    mv "$extracted_bun" "$BUN_PATH"
    chmod +x "$BUN_PATH"

    # Create bunx symlink
    ln -sf "$BUN_PATH" "${BUN_BIN}/bunx"

    # Cleanup
    rm -rf "$tmpdir"

    echo "Bun v${version} installed to $BUN_PATH"
}

# Main logic
main() {
    echo "Setting up Bun..."
    echo "Requested version: $REQUESTED_VERSION"
    echo "Install path: $BUN_INSTALL"

    # Resolve version
    local target_version
    if [[ "$REQUESTED_VERSION" == "latest" ]]; then
        target_version=$(resolve_version "latest")
        if [[ -z "$target_version" ]]; then
            echo "Warning: Could not resolve latest version, will use existing or fail"
        fi
        echo "Latest version: $target_version"
    else
        target_version="$REQUESTED_VERSION"
    fi

    # Check for existing installation
    local installed_version=$(get_installed_version)
    local cache_hit="false"

    if [[ -n "$installed_version" ]]; then
        echo "Found existing Bun: v${installed_version}"

        # For pinned versions, check if it matches
        if [[ "$REQUESTED_VERSION" != "latest" ]]; then
            if [[ "$installed_version" == "$target_version" ]]; then
                echo "Version matches, using cached installation"
                cache_hit="true"
            else
                echo "Version mismatch, reinstalling..."
                install_bun "$target_version"
            fi
        else
            # For "latest", use existing if we couldn't resolve or if it matches
            if [[ -z "$target_version" || "$installed_version" == "$target_version" ]]; then
                echo "Using existing installation"
                cache_hit="true"
            else
                echo "Newer version available, updating..."
                install_bun "$target_version"
            fi
        fi
    else
        # No existing installation
        if [[ -z "$target_version" ]]; then
            echo "Error: No existing Bun and could not resolve version"
            exit 1
        fi
        install_bun "$target_version"
    fi

    # Verify installation
    if [[ ! -x "$BUN_PATH" ]]; then
        echo "Error: Bun installation failed"
        exit 1
    fi

    local final_version=$("$BUN_PATH" --version)
    echo "Bun v${final_version} ready"

    # Add to PATH
    echo "${BUN_BIN}" >> "$GITHUB_PATH"

    # Set BUN_INSTALL_CACHE_DIR for package extraction
    # This is needed for bun install to have a writable tempdir
    local cache_dir="${BUN_INSTALL}/cache"
    mkdir -p "$cache_dir"
    echo "BUN_INSTALL_CACHE_DIR=${cache_dir}" >> "$GITHUB_ENV"

    # Set outputs
    output "bun-version" "$final_version"
    output "bun-path" "$BUN_PATH"
    output "cache-hit" "$cache_hit"
}

main
