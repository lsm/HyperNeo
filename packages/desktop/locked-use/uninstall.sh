#!/bin/bash
# Removes Locked Use and returns the screen-unlock rule to its original single rule.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
right=system.login.screensaver
mine=io.hyperneo.locked-use.unlock
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
buddy() { /usr/libexec/PlistBuddy "$@"; }

security authorizationdb read "$right" > "$work/rule.plist" 2>/dev/null
if [[ "$(buddy -c 'Print :rule:0' "$work/rule.plist")" == "$mine" ]]; then
    buddy -c 'Delete :rule:0' -c 'Delete :k-of-n' "$work/rule.plist"
    security authorizationdb write "$right" < "$work/rule.plist"
fi
security authorizationdb remove "$mine" 2>/dev/null || true
rm -rf /Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle
security authorizationdb read "$right" > "$work/after.plist" 2>/dev/null
buddy -c 'Print :rule' "$work/after.plist"
echo "removed"
