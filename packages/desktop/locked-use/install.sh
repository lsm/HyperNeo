#!/bin/bash
# Opt-in install for Locked Use. Run as root: install.sh <HyperNeoLockedUse.bundle>
# Adds one alternative to the screen-unlock rule. The original rule, usually the
# login window password prompt, stays in place and still unlocks on its own.
set -euo pipefail
[[ $EUID == 0 ]] || { echo "run with sudo" >&2; exit 1; }
source="${1:?HyperNeoLockedUse.bundle}"
right=system.login.screensaver
mine=io.hyperneo.locked-use.unlock
plugin=/Library/Security/SecurityAgentPlugins/HyperNeoLockedUse.bundle
backup="/Library/Application Support/HyperNeo/LockedUse/screensaver-rule.backup.plist"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
buddy() { /usr/libexec/PlistBuddy "$@"; }

codesign --verify --strict -R='anchor apple generic and certificate leaf[subject.OU] = "P5R65T296V"' "$source"
security authorizationdb read "$right" > "$work/rule.plist" 2>/dev/null
if [[ "$(buddy -c 'Print :rule:0' "$work/rule.plist")" == "$mine" ]]; then
    echo "already installed"
    exit 0
fi
if buddy -c 'Print :rule:1' "$work/rule.plist" >/dev/null 2>&1 \
    || buddy -c 'Print :k-of-n' "$work/rule.plist" >/dev/null 2>&1; then
    echo "$right is not a single-rule policy; refusing to change it" >&2
    exit 1
fi

mkdir -p "$(dirname "$backup")"
[[ -e "$backup" ]] || cp "$work/rule.plist" "$backup"
rm -rf "$plugin"
ditto "$source" "$plugin"
chown -R root:wheel "$plugin"
codesign --verify --strict "$plugin"

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
buddy -c 'Add :k-of-n integer 1' -c "Add :rule:0 string $mine" "$work/rule.plist"
security authorizationdb write "$right" < "$work/rule.plist"
security authorizationdb read "$right" > "$work/after.plist" 2>/dev/null
buddy -c 'Print :rule' "$work/after.plist"
echo "installed; original rule backed up at $backup"
