#!/bin/bash
# Removes Locked Use and restores the stock screen-unlock rule from install.sh's backup.
# Run as root. Changes nothing unless the root-owned stock backup is valid and the live
# rule equals it, with or without the Locked Use entry install.sh added.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
. "$(dirname "$0")/policy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

read_rule "$work/rule.plist"
plan="$(uninstall_plan "$work/rule.plist")"
case "$plan" in
    restore)
        security authorizationdb write "$right" < "$backup"
        read_rule "$work/restored.plist"
        if ! same_policy "$work/restored.plist" "$backup"; then
            echo "$right did not read back as the backup; leaving the plugin and its right in place" >&2
            exit 1
        fi
        ;;
    clean) ;;
    *)
        echo "$right is not the stock backup or the rule install.sh wrote, or the backup is not valid; refusing" >&2
        exit 1
        ;;
esac
if right_present; then
    security authorizationdb remove "$mine"
fi
rm -rf "$plugin"

read_rule "$work/after.plist"
same_policy "$work/after.plist" "$backup" || { echo "$right is not the stock rule after removal" >&2; exit 1; }
right_absent || { echo "$mine is still defined or could not be read" >&2; exit 1; }
[[ ! -e "$plugin" ]] || { echo "$plugin is still present" >&2; exit 1; }
rule_of "$work/after.plist"
echo "removed"
