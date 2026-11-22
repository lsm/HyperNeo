#!/bin/bash
# Compiles the unsigned Locked Use authorization plugin bundle to $1. The caller signs it.
set -euo pipefail
bundle="${1:?output bundle}"
[[ "$bundle" == /* ]] || bundle="$PWD/$bundle"
cd "$(dirname "$0")"
rm -rf "$bundle"
mkdir -p "$bundle/Contents/MacOS"
cp Info.plist "$bundle/Contents/Info.plist"
clang -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -bundle -O2 -Wall -Werror \
    -o "$bundle/Contents/MacOS/HyperNeoLockedUse" plugin.c
