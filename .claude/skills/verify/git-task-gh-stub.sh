#!/bin/bash
RUN=$(cd "$(dirname "$0")/.." && pwd)
printf '%s\n' "gh $*" >> "$RUN/evidence/gh.log"
if [ "$1" = pr ] && [ "$2" = view ]; then cat "$RUN/pr.json"; exit 0; fi
if [ "$1" = pr ] && [ "$2" = checks ]; then cat "$RUN/checks.json"; exit 0; fi
printf '%s\n' "synthetic gh: unsupported request" >&2
exit 1
