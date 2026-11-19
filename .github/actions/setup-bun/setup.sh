#!/bin/bash
# Setup Bun - Simple bash-based installer with local caching
set -e

BUN_INSTALL="${HOME}/.bun"
BUN_BIN="${BUN_INSTALL}/bin"
# Git Bash on Windows runners reports MINGW*/MSYS*/CYGWIN* from uname -s and
# needs the .exe suffix plus native (backslash) paths wherever values escape
# to non-MSYS consumers (GITHUB_PATH, GITHUB_ENV, bun itself).
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) IS_WINDOWS="true"; BUN_EXE=".exe" ;;
    *)                     IS_WINDOWS="false"; BUN_EXE="" ;;
esac
BUN_PATH="${BUN_BIN}/bun${BUN_EXE}"
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

has_avx2() {
    case "$1" in
        linux) grep -q avx2 /proc/cpuinfo 2>/dev/null ;;
        darwin) [[ "$(sysctl -n hw.optional.avx2_0 2>/dev/null)" == "1" ]] ;;
        windows) pwsh -NoProfile -NonInteractive -Command \
            'if ([System.Runtime.Intrinsics.X86.Avx2]::IsSupported) { exit 0 }; exit 1' 2>/dev/null ;;
    esac
}

# npm dist.integrity for the official Bun 1.4.4 archives, decoded to hex.
bun_npm_sha512() {
    case "$1" in
        bun-darwin-aarch64)     echo cd6fe1c7073cb090082c6c01e5e4c2e22e3ca2e1977f457896bc6610e93724813a2646155b54d9875136a487a6a6ab1ece05b5b1c9132080ee74538df1b27633 ;;
        bun-darwin-x64)         echo a0a19cc4bb2f878a078c0a36f273e6f1cff1374a3f3a61b28f520761cf78be9ae45ac5b684d83691e119b797f8d1c2391efbb88c395245347450da6fd54200c7 ;;
        bun-darwin-x64-baseline) echo bb34977244e734d4bb527d62862337d51ecfe622a7759eb9b7a663de223bd92adfa15dae23decc28cf33d6a7abda8447caa5c72d42094c8863faa4f951e123af ;;
        bun-windows-x64)        echo 6b72cd72d0553bc3e378fb0565fc0395e17625761fd817d0d6efcf2d19c10cb9c2d918a697ee3e2e02692a3e31446841f762b0786c902393d769390ff6aca931 ;;
        bun-windows-x64-baseline) echo 73ed7af55fa895edbdb24e46a45ba1e90e2e370443aaef6d5d901551822c75f1997a225e76e434df4064c478b73e63698fbc3f79cdbea0eda8911155142f62d6 ;;
        bun-linux-x64)          echo 0876db9261d5336f13d4616afba18be00a38ba3c306308f50b1145c041732da9cf7cdb0877d0216c83f4438ade5ae5819068a6524a10ca0acaed1823b63defa2 ;;
        bun-linux-x64-baseline) echo 14153a4f6d4d4fe8beac449b8b467c03c1b9c4de7573e599d2fea922323ab334b33a5a9536feb89dfec53e7c0d232c4a0f533b5a0e5c1286cb0bf41bcc278bb4 ;;
        bun-linux-aarch64)      echo 65356da5ff7398748154f5f5b01c1ee5a8066ffacddf8c8f1a0fc76f2f1ed80c76b82500d944592a5647eea2e7b4aeea68524231787dbf4196358376cc8373d7 ;;
        *) return 1 ;;
    esac
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
        MINGW*|MSYS*|CYGWIN*) os="windows" ;;
        *)      echo "Unsupported OS: $(uname -s)"; exit 1 ;;
    esac

    # Use the baseline x64 build when AVX2 support cannot be confirmed.
    local avx2=""
    if [[ "$arch" == "x64" ]]; then
        if has_avx2 "$os"; then
            avx2="true"
        else
            avx2="false"
        fi
    fi

    local package="bun-${os}-${arch}"
    if [[ "$avx2" == "false" ]]; then
        package="${package}-baseline"
    fi
    local url="https://github.com/oven-sh/bun/releases/download/bun-v${version}/${package}.zip"

    # Download and extract
    local tmpdir=$(mktemp -d)
    local zipfile="${tmpdir}/bun.zip"

    # Git Bash does not ship unzip; fall back to 7z (preinstalled on GitHub
    # Windows runners) and then to PowerShell's Expand-Archive with native paths.
    echo "Downloading from: $url"
    if ! curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 -o "$zipfile" "$url"; then
        [[ "$version" == "1.4.4" ]] || return 1
        local sha512
        sha512=$(bun_npm_sha512 "$package") || return 1
        local archive="${tmpdir}/bun.tgz"
        local checksum=(sha512sum)
        if [[ "$os" == "darwin" ]]; then
            if command -v gsha512sum >/dev/null 2>&1; then
                checksum=(gsha512sum)
            else
                checksum=(shasum -a 512)
            fi
        fi
        echo "GitHub download failed; trying the pinned Bun package from npm"
        curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 -o "$archive" \
            "https://registry.npmjs.org/@oven/${package}/-/${package}-${version}.tgz"
        printf '%s  %s\n' "$sha512" "$archive" | "${checksum[@]}" --check
        tar -xzf "$archive" -C "$tmpdir" "package/bin/bun${BUN_EXE}"
    elif command -v unzip >/dev/null 2>&1; then
        unzip -o -q "$zipfile" -d "$tmpdir"
    elif command -v 7z >/dev/null 2>&1; then
        7z x -y -bd -o"$tmpdir" "$zipfile" >/dev/null
    elif command -v powershell >/dev/null 2>&1; then
        local win_zipfile win_tmpdir
        win_zipfile=$(cygpath -w "$zipfile")
        win_tmpdir=$(cygpath -w "$tmpdir")
        powershell -NoProfile -Command \
            "Expand-Archive -LiteralPath '$win_zipfile' -DestinationPath '$win_tmpdir' -Force"
    else
        echo "Error: No unzip tool available (unzip, 7z, or powershell)"
        exit 1
    fi

    # Find and install the bun binary
    local extracted_bun=$(find "$tmpdir" -name "bun${BUN_EXE}" -type f -executable | head -1)
    if [[ -z "$extracted_bun" ]]; then
        extracted_bun=$(find "$tmpdir" -name "bun${BUN_EXE}" -type f | head -1)
    fi

    if [[ -z "$extracted_bun" ]]; then
        echo "Error: Could not find bun binary in archive"
        exit 1
    fi

    mkdir -p "$BUN_BIN"
    mv "$extracted_bun" "$BUN_PATH"
    chmod +x "$BUN_PATH" || [[ "$IS_WINDOWS" == "true" ]]

    # Create bunx symlink (a copy on Windows; MSYS ln -s would copy without
    # the .exe suffix, which Windows cannot execute)
    if [[ "$IS_WINDOWS" == "true" ]]; then
        cp -f "$BUN_PATH" "${BUN_BIN}/bunx.exe"
    else
        ln -sf "$BUN_PATH" "${BUN_BIN}/bunx"
    fi

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
    if [[ ! -x "$BUN_PATH" && "$IS_WINDOWS" != "true" ]]; then
        echo "Error: Bun installation failed"
        exit 1
    fi
    if [[ ! -f "$BUN_PATH" ]]; then
        echo "Error: Bun installation failed"
        exit 1
    fi

    local final_version=$("$BUN_PATH" --version)
    echo "Bun v${final_version} ready"

    # Add to PATH (native backslash path on Windows so non-MSYS steps —
    # PowerShell, cmd, and the runner itself — resolve it too)
    if [[ "$IS_WINDOWS" == "true" ]]; then
        cygpath -w "$BUN_BIN" >> "$GITHUB_PATH"
    else
        echo "${BUN_BIN}" >> "$GITHUB_PATH"
    fi

    # Set BUN_INSTALL_CACHE_DIR for package extraction
    # This is needed for bun install to have a writable tempdir
    local cache_dir="${BUN_INSTALL}/cache"
    mkdir -p "$cache_dir"
    if [[ "$IS_WINDOWS" == "true" ]]; then
        echo "BUN_INSTALL_CACHE_DIR=$(cygpath -w "$cache_dir")" >> "$GITHUB_ENV"
    else
        echo "BUN_INSTALL_CACHE_DIR=${cache_dir}" >> "$GITHUB_ENV"
    fi

    # Set outputs
    output "bun-version" "$final_version"
    output "bun-path" "$BUN_PATH"
    output "cache-hit" "$cache_hit"
}

main
