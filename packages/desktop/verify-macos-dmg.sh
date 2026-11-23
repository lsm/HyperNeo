#!/bin/bash
set -euo pipefail

dmg="$1"
stapler_status=0
gatekeeper_status=0
xcrun stapler validate "$dmg" || stapler_status=$?
spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg" || gatekeeper_status=$?
printf 'DMG validation: stapler=%d Gatekeeper=%d (%s)\n' "$stapler_status" "$gatekeeper_status" "$(basename "$dmg")"
[[ "$stapler_status" == 0 && "$gatekeeper_status" == 0 ]]
