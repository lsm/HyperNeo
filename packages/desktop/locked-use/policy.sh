#!/bin/bash
# Shared by install.sh and uninstall.sh: names and checks of the screen-unlock policy.
# Every check fails closed: a tool error counts as a failed check, never as a pass.
right=system.login.screensaver
mine=io.hyperneo.locked-use.unlock
plugin=/Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle
backup="/Library/Application Support/HyperNeo/LockedUse/screensaver-rule.backup.plist"
plugin_requirement='identifier "io.hyperneo.locked-use.plugin" and anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'

read_rule() { security authorizationdb read "$right" > "$1" 2>/dev/null; }
rule_of() { plutil -extract rule json -o - "$1"; }

is_stock() {
    local class rule
    plutil -lint -s "$1" >/dev/null || return 1
    class="$(plutil -extract class raw -o - "$1")" || return 1
    rule="$(plutil -extract rule json -o - "$1")" || return 1
    [[ "$class" == rule && "$rule" == '["use-login-window-ui"]' ]] || return 1
    ! plutil -extract k-of-n raw -o - "$1" >/dev/null 2>&1
}

normalized() {
    local copy key
    copy="$(mktemp)" || return 1
    cp "$1" "$copy" || { rm -f "$copy"; return 1; }
    for key in created modified version; do
        if plutil -extract "$key" raw -o - "$copy" >/dev/null 2>&1; then
            plutil -remove "$key" "$copy" || { rm -f "$copy"; return 1; }
        fi
    done
    plutil -convert xml1 -o "$2" "$copy" || { rm -f "$copy"; return 1; }
    rm -f "$copy"
}

same_policy() {
    local dir status=1
    dir="$(mktemp -d)" || return 1
    if normalized "$1" "$dir/a" && normalized "$2" "$dir/b" && [[ -s "$dir/a" && -s "$dir/b" ]]; then
        cmp -s "$dir/a" "$dir/b" && status=0
    fi
    rm -rf "$dir"
    return "$status"
}

installed_from() {
    cp "$1" "$2" && /usr/libexec/PlistBuddy -c 'Add :k-of-n integer 1' -c "Add :rule:0 string $mine" "$2" >/dev/null
}

right_present() { security authorizationdb read "$mine" >/dev/null 2>&1; }

right_absent() {
    local out
    if out="$(security authorizationdb read "$mine" 2>&1)"; then return 1; fi
    [[ "$out" == *"(-60005)"* ]]
}

no_acl_or_xattr() {
    local listing attributes
    listing="$(find "$1" -exec ls -lde {} +)" || return 1
    [[ -n "$listing" ]] || return 1
    ! grep -qE '^ [0-9]+: ' <<< "$listing" || return 1
    attributes="$(xattr -r "$1")" || return 1
    [[ -z "$(grep -v ': com\.apple\.provenance$' <<< "$attributes")" ]]
}

clean_tree() {
    local found
    found="$(find "$1" \( ! -user root -o ! -group wheel -o -perm -g+w -o -perm -o+w -o -type l \) -print)" || return 1
    [[ -z "$found" ]] && no_acl_or_xattr "$1"
}

root_file() {
    local mode
    mode="$(stat -f '%Su:%Lp' "$1")" || return 1
    [[ "$mode" == root:644 && -f "$1" && ! -L "$1" ]] && no_acl_or_xattr "$1"
}

valid_backup() { [[ -f "$backup" ]] && root_file "$backup" && is_stock "$backup"; }

uninstall_plan() {
    local expected
    valid_backup || { echo refuse; return; }
    expected="$(mktemp)" || { echo refuse; return; }
    if ! installed_from "$backup" "$expected"; then
        echo refuse
    elif same_policy "$1" "$expected"; then
        echo restore
    elif same_policy "$1" "$backup"; then
        echo clean
    else
        echo refuse
    fi
    rm -f "$expected"
}
