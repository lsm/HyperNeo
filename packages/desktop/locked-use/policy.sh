#!/bin/bash
# Shared by install.sh and uninstall.sh: names and checks of the screen-unlock policy.
right=system.login.screensaver
mine=io.hyperneo.locked-use.unlock
plugin=/Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle
backup="/Library/Application Support/HyperNeo/LockedUse/screensaver-rule.backup.plist"
plugin_requirement='identifier "io.hyperneo.locked-use.plugin" and anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

rule_of() { plutil -extract rule json -o - "$1" 2>/dev/null; }
class_of() { plutil -extract class raw -o - "$1" 2>/dev/null; }
k_of_n() { plutil -extract k-of-n raw -o - "$1" 2>/dev/null; }

is_stock() {
    [[ "$(class_of "$1")" == rule && "$(rule_of "$1")" == '["use-login-window-ui"]' ]] && ! k_of_n "$1" >/dev/null
}

read_rule() { security authorizationdb read "$right" > "$1" 2>/dev/null; }

normalized() {
    local copy
    copy="$(mktemp)"
    cp "$1" "$copy"
    for key in created modified version; do /usr/libexec/PlistBuddy -c "Delete :$key" "$copy" >/dev/null 2>&1 || true; done
    plutil -convert xml1 -o - "$copy"
    rm -f "$copy"
}

same_policy() { [[ "$(normalized "$1")" == "$(normalized "$2")" ]]; }

installed_from() {
    cp "$1" "$2"
    /usr/libexec/PlistBuddy -c 'Add :k-of-n integer 1' -c "Add :rule:0 string $mine" "$2"
}

root_only_tree() {
    [[ -z "$(find "$1" \( ! -user root -o ! -group wheel -o -perm -g+w -o -perm -o+w -o -type l \) -print)" ]] \
        && ! find "$1" -exec ls -lde {} + | grep -qE '^ [0-9]+: '
}
