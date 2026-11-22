#!/bin/bash
# Exits 0 only when every architecture slice of the code at $1 is signed with the hardened runtime.
set -euo pipefail
code="${1:?code path}"
codesign --display --verbose=2 "$code" 2>&1 | grep -E 'flags=0x[0-9a-f]+\([^)]*runtime' >/dev/null
