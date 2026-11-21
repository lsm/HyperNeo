#!/bin/bash
# Opt-in install for Locked Use. Run as root: install.sh <HyperNeoLockedUse.bundle>
# Adds one alternative to the stock screen-unlock rule. The login window password
# prompt stays in place and still unlocks on its own. Any failure restores the stock rule.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
source="${1:?HyperNeoLockedUse.bundle}"
. "$(dirname "$0")/policy.sh"
work="$(mktemp -d)"
staged=""
trap 'rm -rf "$work" ${staged:+"$staged"}' EXIT

verified_plugin() {
    root_only_tree "$1" && codesign --verify --strict --test-requirement="=$plugin_requirement" "$1"
}

read_rule "$work/rule.plist"
if [[ -f "$backup" ]] && is_stock "$backup" && installed_from "$backup" "$work/expected.plist" \
    && same_policy "$work/rule.plist" "$work/expected.plist" \
    && security authorizationdb read "$mine" >/dev/null 2>&1 && verified_plugin "$plugin" 2>/dev/null; then
    echo "already installed"
    exit 0
fi
if ! is_stock "$work/rule.plist"; then
    echo "$right is not the stock use-login-window-ui rule; refusing to change it" >&2
    exit 1
fi

staged="$(mktemp -d /Library/Security/SecurityAgentPlugins/.HyperNeoLockedUse.XXXXXX)"
ditto --noacl --noextattr --noqtn "$source" "$staged/HyperNeoLockedUse.bundle"
chmod -R -N "$staged"
chown -R root:wheel "$staged"
chmod -R u=rwX,go=rX "$staged"
verified_plugin "$staged/HyperNeoLockedUse.bundle"

mkdir -p "$(dirname "$backup")"
cp "$work/rule.plist" "$backup"
chown root:wheel "$backup"
chmod 644 "$backup"
installed_from "$backup" "$work/expected.plist"

rollback() {
    trap - ERR
    set +e
    security authorizationdb write "$right" < "$backup"
    if read_rule "$work/restored.plist" && same_policy "$work/restored.plist" "$backup"; then
        security authorizationdb remove "$mine" >/dev/null 2>&1
        rm -rf "$plugin"
        echo "install failed; stock rule restored" >&2
    else
        echo "INSTALL FAILED AND THE STOCK RULE WAS NOT RESTORED." >&2
        echo "The plugin and its right are left in place. Restore $right from $backup." >&2
    fi
    exit 1
}
trap rollback ERR

rm -rf "$plugin"
mv "$staged/HyperNeoLockedUse.bundle" "$plugin"
verified_plugin "$plugin"
cat > "$work/mine.plist" <<EOF
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
security authorizationdb write "$mine" < "$work/mine.plist"
security authorizationdb write "$right" < "$work/expected.plist"
read_rule "$work/after.plist"
same_policy "$work/after.plist" "$work/expected.plist"
trap - ERR
rule_of "$work/after.plist"
echo "installed; stock rule backed up at $backup"
