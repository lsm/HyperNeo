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

read_rule "$work/rule.plist"
case "$(install_plan "$work/rule.plist")" in
    installed) echo "already installed"; exit 0 ;;
    fresh) ;;
    *)
        echo "$right is not the stock use-login-window-ui rule, or $mine is still defined or unknown;" >&2
        echo "refusing to change anything. Run uninstall.sh first." >&2
        exit 1
        ;;
esac

staged="$(mktemp -d /Library/Security/SecurityAgentPlugins/.HyperNeoLockedUse.XXXXXX)"
ditto --noacl --noextattr --noqtn "$source" "$staged/HyperNeoLockedUse.bundle"
chmod -R -N "$staged"
chown -R root:wheel "$staged"
chmod -R u=rwX,go=rX "$staged"
verified_plugin "$staged/HyperNeoLockedUse.bundle"

mkdir -p "$(dirname "$backup")"
cp "$work/rule.plist" "$backup"
chown root:wheel "$backup"
chmod -N "$backup"
chmod 644 "$backup"
valid_backup
same_policy "$backup" "$work/rule.plist"
installed_from "$backup" "$work/expected.plist"

rollback() {
    trap - ERR
    set +e
    rollback_install "$work"
    exit 1
}
trap rollback ERR

rm -rf "$plugin"
mv "$staged/HyperNeoLockedUse.bundle" "$plugin"
verified_plugin "$plugin"
write_right_definition "$work/mine.plist"
security authorizationdb write "$mine" < "$work/mine.plist"
installed_right
security authorizationdb write "$right" < "$work/expected.plist"
read_rule "$work/after.plist"
same_policy "$work/after.plist" "$work/expected.plist"
trap - ERR
rule_of "$work/after.plist"
echo "installed; stock rule backed up at $backup"
