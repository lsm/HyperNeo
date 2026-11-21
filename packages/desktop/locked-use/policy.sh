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

write_right_definition() {
    cat > "$1" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>class</key><string>evaluate-mechanisms</string>
<key>comment</key><string>HyperNeo Locked Use: unlocks only for the signed HyperNeo guardian.</string>
<key>mechanisms</key><array><string>HyperNeoLockedUse:unlock,privileged</string></array>
<key>shared</key><false/>
<key>tries</key><integer>1</integer>
</dict></plist>
EOF
}

installed_right() {
    local definition status=1
    [[ "$(right_state)" == present ]] || return 1
    definition="$(mktemp)" || return 1
    security authorizationdb read "$mine" > "$definition" 2>/dev/null && policy right "$definition" && status=0
    rm -f "$definition"
    return "$status"
}

remove_right() {
    local state
    state="$(right_state)" || return 1
    if [[ "$state" == present ]]; then
        security authorizationdb remove "$mine" >/dev/null || return 1
        state="$(right_state)" || return 1
    fi
    [[ "$state" == absent ]]
}

rollback_install() {
    security authorizationdb write "$right" < "$backup"
    if ! read_rule "$1/restored.plist" || ! same_policy "$1/restored.plist" "$backup"; then
        echo "INSTALL FAILED AND THE STOCK RULE WAS NOT RESTORED." >&2
        echo "The plugin and its right are left in place. Restore $right from $backup." >&2
        return 1
    fi
    if ! remove_right; then
        echo "Install failed; the stock rule is restored, but $mine could not be proven removed." >&2
        echo "The plugin is left in place. Run uninstall.sh to finish." >&2
        return 1
    fi
    rm -rf "$plugin"
    [[ ! -e "$plugin" ]] || { echo "Install failed; the stock rule is restored, but $plugin remains." >&2; return 1; }
    echo "install failed; stock rule restored and Locked Use removed" >&2
}

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
    local names
    names="$(xattr "$1" && echo end)" || return 1
    [[ "$names" == end || "$names" == $'com.apple.provenance\nend' ]]
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

verified_plugin() {
    clean_tree "$1" && codesign --verify --strict --test-requirement="=$plugin_requirement" "$1"
}

install_plan() {
    local state
    if [[ "$(uninstall_plan "$1")" == restore ]] && installed_right && verified_plugin "$plugin" 2>/dev/null; then
        echo installed
        return
    fi
    state="$(right_state)" || { echo refuse; return; }
    if is_stock "$1" && [[ "$state" == absent ]]; then echo fresh; else echo refuse; fi
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
    remove_right || { echo "$mine could not be proven removed; leaving the plugin in place" >&2; return 1; }
    rm -rf "$plugin"
    [[ ! -e "$plugin" ]] || { echo "$plugin is still present" >&2; return 1; }
    read_rule "$work/after.plist" && same_policy "$work/after.plist" "$backup" || {
        echo "$right is not the stock rule after removal" >&2
        return 1
    }
    rule_of "$work/after.plist"
    rm -rf "$work"
}
