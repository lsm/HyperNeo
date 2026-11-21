#!/bin/bash
# Removes Locked Use and restores the stock screen-unlock rule from install.sh's backup.
# Run as root. Refuses, changing nothing, unless the rule is exactly what install.sh
# wrote or already the stock rule.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
. "$(dirname "$0")/policy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

read_rule "$work/rule.plist"
if [[ -f "$backup" ]] && is_stock "$backup" && installed_from "$backup" "$work/expected.plist" \
    && same_policy "$work/rule.plist" "$work/expected.plist"; then
    security authorizationdb write "$right" < "$backup"
    read_rule "$work/restored.plist"
    same_policy "$work/restored.plist" "$backup" || {
        echo "$right did not match the backup after restoring; leaving the plugin in place" >&2
        exit 1
    }
elif ! is_stock "$work/rule.plist"; then
    echo "$right is not the rule install.sh wrote, or its backup is missing; refusing to change it" >&2
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
