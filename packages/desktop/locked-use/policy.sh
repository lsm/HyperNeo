#!/bin/bash
# Shared by install.sh and uninstall.sh: names and checks of the screen-unlock policy.
# Every check fails closed: a tool error counts as a failed check, never as a pass.
right=system.login.screensaver
mine=io.hyperneo.locked-use.unlock
plugin=/Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle
backup="/Library/Application Support/HyperNeo/LockedUse/screensaver-rule.backup.plist"
authdb=/var/db/auth.db
plugin_requirement='identifier "io.hyperneo.locked-use.plugin" and anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
policy_script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.jxa"

read_rule() { security authorizationdb read "$right" > "$1" 2>/dev/null; }
rule_of() { plutil -extract rule json -o - "$1"; }
policy() { osascript -l JavaScript "$policy_script" "$@" >/dev/null 2>&1; }
is_stock() { policy stock "$1"; }
same_policy() { policy same "$1" "$2"; }
installed_from() { rm -f "$2" && policy installed "$1" "$2"; }

right_state() {
    local count
    count="$(sqlite3 -readonly "$authdb" "select count(*) from rules where name = '$mine';")" || return 1
    case "$count" in
        0) echo absent ;;
        1) echo present ;;
        *) return 1 ;;
    esac
}

only_provenance() {
    local names name
    names="$(xattr "$1")" || return 1
    while IFS= read -r name; do
        [[ -z "$name" || "$name" == com.apple.provenance ]] || return 1
    done <<< "$names"
}

clean_entry() {
    local mode listing
    mode="$(stat -f '%Su:%Sg:%Mp%Lp:%HT' "$1")" || return 1
    [[ "$mode" =~ ^root:wheel:0[0-7][0145][0145]:(Regular\ File|Directory)$ ]] || return 1
    listing="$(ls -lde "$1")" || return 1
    [[ -n "$listing" && "$listing" != *$'\n'* ]] || return 1
    only_provenance "$1"
}

clean_tree() {
    local list entry count=0
    list="$(mktemp)" || return 1
    if ! find "$1" -print0 > "$list"; then rm -f "$list"; return 1; fi
    while IFS= read -r -d '' entry; do
        count=$((count + 1))
        clean_entry "$entry" || { rm -f "$list"; return 1; }
    done < "$list"
    rm -f "$list"
    ((count > 0))
}

root_file() {
    local mode listing
    mode="$(stat -f '%Su:%Mp%Lp:%HT' "$1")" || return 1
    [[ "$mode" == "root:0644:Regular File" ]] || return 1
    listing="$(ls -lde "$1")" || return 1
    [[ -n "$listing" && "$listing" != *$'\n'* ]] || return 1
    only_provenance "$1"
}

valid_backup() { [[ -f "$backup" ]] && root_file "$backup" && is_stock "$backup"; }

uninstall_plan() {
    local expected plan=refuse
    valid_backup || { echo refuse; return; }
    expected="$(mktemp)" || { echo refuse; return; }
    if installed_from "$backup" "$expected"; then
        if same_policy "$1" "$expected"; then
            plan=restore
        elif same_policy "$1" "$backup"; then
            plan=clean
        fi
    fi
    rm -f "$expected"
    echo "$plan"
}

uninstall_locked_use() {
    local work plan state
    work="$(mktemp -d)" || return 1
    read_rule "$work/rule.plist" || { echo "cannot read $right" >&2; return 1; }
    plan="$(uninstall_plan "$work/rule.plist")"
    case "$plan" in
        restore)
            security authorizationdb write "$right" < "$backup" || return 1
            read_rule "$work/restored.plist" && same_policy "$work/restored.plist" "$backup" || {
                echo "$right did not read back as the backup; leaving the plugin and its right in place" >&2
                return 1
            }
            ;;
        clean) ;;
        *)
            echo "$right is not the stock backup or the rule install.sh wrote, or the backup is not valid; refusing" >&2
            return 1
            ;;
    esac
    state="$(right_state)" || { echo "cannot tell whether $mine exists; leaving the plugin in place" >&2; return 1; }
    if [[ "$state" == present ]]; then
        security authorizationdb remove "$mine" || { echo "cannot remove $mine; leaving the plugin in place" >&2; return 1; }
        state="$(right_state)" || state=unknown
        [[ "$state" == absent ]] || { echo "$mine is still defined; leaving the plugin in place" >&2; return 1; }
    fi
    rm -rf "$plugin"
    [[ ! -e "$plugin" ]] || { echo "$plugin is still present" >&2; return 1; }
    read_rule "$work/after.plist" && same_policy "$work/after.plist" "$backup" || {
        echo "$right is not the stock rule after removal" >&2
        return 1
    }
    rule_of "$work/after.plist"
    rm -rf "$work"
}
