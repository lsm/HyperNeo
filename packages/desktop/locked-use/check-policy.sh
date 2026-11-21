#!/bin/bash
# Checks that the install and uninstall policy checks fail closed. No root and no change
# to the authorization database: it works on copies of rule files and injects tool failures.
# Usage: check-policy.sh <stock rule plist>   (for example a saved `security authorizationdb read system.login.screensaver`)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/policy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stock="${1:?stock rule plist}"
failed=0

expect() {
    local want="$1" name="$2" got
    shift 2
    if "$@"; then got=pass; else got=fail; fi
    echo "$name=$got"
    [[ "$got" == "$want" ]] || failed=1
}
plan_is() { [[ "$(uninstall_plan "$2")" == "$1" ]]; }

fake() {
    mkdir -p "$work/bin-$1"
    printf '#!/bin/bash\n%s\n' "$2" > "$work/bin-$1/$3"
    chmod +x "$work/bin-$1/$3"
}
with() { PATH="$work/bin-$1:$PATH" "${@:2}"; }

is_stock "$stock" || { echo "not a stock rule: $stock" >&2; exit 2; }
cp "$stock" "$work/backup.plist"
installed_from "$work/backup.plist" "$work/installed.plist"
cp "$work/installed.plist" "$work/drift.plist"
/usr/libexec/PlistBuddy -c 'Add :shared bool true' "$work/drift.plist"
cp "$work/backup.plist" "$work/stock-drift.plist"
/usr/libexec/PlistBuddy -c 'Set :comment changed' "$work/stock-drift.plist"
cp "$work/backup.plist" "$work/custom.plist"
/usr/libexec/PlistBuddy -c 'Set :rule:0 authenticate-session-owner' "$work/custom.plist"
echo 'not a plist' > "$work/broken.plist"

expect pass stock is_stock "$work/backup.plist"
expect fail custom_rule is_stock "$work/custom.plist"
expect fail broken_rule is_stock "$work/broken.plist"
expect pass installed_matches same_policy "$work/installed.plist" "$work/installed.plist"
expect fail drift_differs same_policy "$work/drift.plist" "$work/installed.plist"
expect fail broken_never_equal same_policy "$work/broken.plist" "$work/broken.plist"

fake convert 'for a in "$@"; do [[ "$a" == -convert ]] && exit 1; done; exec /usr/bin/plutil "$@"' plutil
expect fail convert_error_never_equal with convert same_policy "$work/installed.plist" "$work/installed.plist"
fake remove 'for a in "$@"; do [[ "$a" == -remove ]] && exit 1; done; exec /usr/bin/plutil "$@"' plutil
expect fail remove_error_never_equal with remove same_policy "$work/installed.plist" "$work/installed.plist"

backup="$work/backup.plist"
root_file() { [[ "$1" == "$backup" ]]; }
expect pass plan_restore plan_is restore "$work/installed.plist"
expect pass plan_clean plan_is clean "$work/backup.plist"
expect pass plan_refuses_drift plan_is refuse "$work/drift.plist"
expect pass plan_refuses_stock_drift plan_is refuse "$work/stock-drift.plist"
expect pass plan_refuses_broken_live plan_is refuse "$work/broken.plist"
expect pass plan_refuses_convert_error with convert plan_is refuse "$work/installed.plist"
backup="$work/missing.plist"
expect pass plan_refuses_missing_backup plan_is refuse "$work/backup.plist"
backup="$work/custom.plist"
expect pass plan_refuses_custom_backup plan_is refuse "$work/custom.plist"
backup="$work/backup.plist"
root_file() { return 1; }
expect pass plan_refuses_unowned_backup plan_is refuse "$work/installed.plist"
unset -f root_file
. "$here/policy.sh"

expect fail backup_not_root root_file "$work/backup.plist"
mkdir -p "$work/tree/Contents"
expect fail tree_not_root clean_tree "$work/tree"
user="$(id -un)"
group="$(id -gn)"
fake findok "args=(); for a in \"\$@\"; do case \"\$a\" in root) args+=(\"$user\");; wheel) args+=(\"$group\");; *) args+=(\"\$a\");; esac; done; exec /usr/bin/find \"\${args[@]}\"" find
chmod -R go-w "$work/tree"
expect pass tree_clean with findok clean_tree "$work/tree"
fake findfail 'exit 1' find
expect fail find_error with findfail clean_tree "$work/tree"
fake lsfail 'exit 1' ls
expect fail ls_error with findok with lsfail clean_tree "$work/tree"
fake xattrfail 'exit 1' xattr
expect fail xattr_error with findok with xattrfail clean_tree "$work/tree"
xattr -w io.hyperneo.test 1 "$work/tree/Contents"
expect fail tree_xattr with findok clean_tree "$work/tree"
xattr -d io.hyperneo.test "$work/tree/Contents"
chmod +a "everyone allow write" "$work/tree/Contents"
expect fail tree_acl with findok clean_tree "$work/tree"
chmod -N "$work/tree/Contents"
ln -s Contents "$work/tree/link"
expect fail tree_symlink with findok clean_tree "$work/tree"
rm "$work/tree/link"
chmod g+w "$work/tree/Contents"
expect fail tree_group_write with findok clean_tree "$work/tree"

[[ "$failed" == 0 ]] && echo "policy check PASS" || { echo "policy check FAIL"; exit 1; }
