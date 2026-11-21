#!/bin/bash
# Removes Locked Use and restores the stock screen-unlock rule. Run as root.
# Refuses to touch a rule that is neither the stock rule nor the one install.sh wrote.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
. "$(dirname "$0")/policy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

read_rule "$work/rule.plist"
if is_installed "$work/rule.plist"; then
    if [[ -f "$backup" ]] && is_stock "$backup"; then
        security authorizationdb write "$right" < "$backup"
    else
        /usr/libexec/PlistBuddy -c 'Delete :rule:0' -c 'Delete :k-of-n' "$work/rule.plist"
        is_stock "$work/rule.plist"
        security authorizationdb write "$right" < "$work/rule.plist"
    fi
elif ! is_stock "$work/rule.plist"; then
    echo "$right was changed by something else; refusing to change it" >&2
    exit 1
fi
if security authorizationdb read "$mine" >/dev/null 2>&1; then
    security authorizationdb remove "$mine"
fi
rm -rf "$plugin"

read_rule "$work/after.plist"
is_stock "$work/after.plist" || { echo "$right is not the stock rule after removal" >&2; exit 1; }
! security authorizationdb read "$mine" >/dev/null 2>&1 || { echo "$mine is still defined" >&2; exit 1; }
[[ ! -e "$plugin" ]] || { echo "$plugin is still present" >&2; exit 1; }
rule_of "$work/after.plist"
echo "removed"
