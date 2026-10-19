#!/bin/bash
RUN=$(cd "$(dirname "$0")/.." && pwd)
echo "$(date -u +%FT%TZ) gh $*" >> "$RUN/evidence/gh.log"
if [ "$1" = pr ] && [ "$2" = view ] && [ -f "$RUN/pr.json" ]; then
  cat "$RUN/pr.json"
  exit 0
fi
echo "verify gh stub: unsupported gh $*" >&2
exit 1
