#!/bin/bash
# Compiles the unsigned Locked Use guardian to $1. The caller signs it as io.hyperneo.locked-use.
set -euo pipefail
out="${1:?output file}"
[[ "$out" == /* ]] || out="$PWD/$out"
cd "$(dirname "$0")"
clang -arch arm64 -arch x86_64 -mmacosx-version-min=11.0 -fobjc-arc -O2 -Wall -Werror \
    -framework AppKit -framework ApplicationServices -framework IOKit -framework Security \
    -o "$out" guardian.m
