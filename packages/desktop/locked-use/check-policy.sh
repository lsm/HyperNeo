#!/bin/bash
# Checks that the install and uninstall policy checks fail closed. No root and no change to
# the authorization database: it works on copies of rule files, a fixture rules database and
# a fixture plugin folder, and injects tool failures.
# Usage: check-policy.sh <stock rule plist>   (a saved `security authorizationdb read system.login.screensaver`)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/policy.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
stock="${1:?stock rule plist}"
failed=0
user="$(id -un)"
group="$(id -gn)"

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
    printf '#!/bin/bash\n%s\n' "$3" > "$work/bin-$1/$2"
    chmod +x "$work/bin-$1/$2"
}
with() { PATH="$work/bin-$1:$PATH" "${@:2}"; }

is_stock "$stock" || { echo "not a stock rule: $stock" >&2; exit 2; }
cp "$stock" "$work/backup.plist"
installed_from "$work/backup.plist" "$work/installed.plist"
cp "$work/installed.plist" "$work/drift.plist"
plutil -insert shared -bool true "$work/drift.plist"
cp "$work/backup.plist" "$work/stock-drift.plist"
plutil -replace comment -string changed "$work/stock-drift.plist"
cp "$work/backup.plist" "$work/custom.plist"
plutil -replace rule -json '["authenticate-session-owner"]' "$work/custom.plist"
cp "$work/backup.plist" "$work/k-of-n.plist"
plutil -insert k-of-n -integer 1 "$work/k-of-n.plist"
echo 'not a plist' > "$work/broken.plist"

expect pass stock is_stock "$work/backup.plist"
expect fail custom_rule is_stock "$work/custom.plist"
expect fail stock_with_k_of_n is_stock "$work/k-of-n.plist"
expect fail broken_rule is_stock "$work/broken.plist"
expect fail missing_rule is_stock "$work/missing.plist"
expect pass installed_matches same_policy "$work/installed.plist" "$work/installed.plist"
expect fail drift_differs same_policy "$work/drift.plist" "$work/installed.plist"
expect fail broken_never_equal same_policy "$work/broken.plist" "$work/broken.plist"
fake parse osascript 'exit 1'
expect fail parse_error_not_stock with parse is_stock "$work/backup.plist"
expect fail parse_error_never_equal with parse same_policy "$work/installed.plist" "$work/installed.plist"
expect fail parse_error_no_installed with parse installed_from "$work/backup.plist" "$work/out.plist"

backup="$work/backup.plist"
root_file() { [[ "$1" == "$backup" ]]; }
expect pass plan_restore plan_is restore "$work/installed.plist"
expect pass plan_clean plan_is clean "$work/backup.plist"
expect pass plan_refuses_drift plan_is refuse "$work/drift.plist"
expect pass plan_refuses_stock_drift plan_is refuse "$work/stock-drift.plist"
expect pass plan_refuses_broken_live plan_is refuse "$work/broken.plist"
expect pass plan_refuses_parse_error with parse plan_is refuse "$work/installed.plist"
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

fake owner stat "out=\"\$(/usr/bin/stat \"\$@\")\" || exit \$?; sed -e 's/^$user:$group:/root:wheel:/' -e 's/^$user:/root:/' <<< \"\$out\""
mkdir -p "$work/tree/Contents/MacOS"
echo plugin > "$work/tree/Contents/MacOS/plugin"
chmod -R u=rwX,go=rX "$work/tree"
expect fail tree_not_root clean_tree "$work/tree"
expect pass tree_clean with owner clean_tree "$work/tree"
xattr "$work/tree/Contents/MacOS/plugin" | grep -qx com.apple.provenance && echo "provenance_added_by_macos=yes"
xattr -d com.apple.provenance "$work/tree/Contents/MacOS/plugin" 2>/dev/null
xattr "$work/tree/Contents/MacOS/plugin" | grep -qx com.apple.provenance && echo "provenance_survives_removal=yes"
fake findfail find 'exit 1'
expect fail find_error with owner with findfail clean_tree "$work/tree"
fake statfail stat 'exit 1'
expect fail stat_error with statfail clean_tree "$work/tree"
fake lsfail ls 'exit 1'
expect fail ls_error with owner with lsfail clean_tree "$work/tree"
fake xattrfail xattr 'exit 1'
expect fail xattr_error with owner with xattrfail clean_tree "$work/tree"
fake xattrempty xattr 'echo "xattr: error" >&2; exit 1'
expect fail xattr_error_no_output with owner with xattrempty clean_tree "$work/tree"
xattr -w io.hyperneo.test 1 "$work/tree/Contents/MacOS/plugin"
expect fail tree_other_xattr with owner clean_tree "$work/tree"
xattr -d io.hyperneo.test "$work/tree/Contents/MacOS/plugin"
chmod +a "everyone allow write" "$work/tree/Contents"
expect fail tree_acl with owner clean_tree "$work/tree"
chmod -N "$work/tree/Contents"
ln -s MacOS "$work/tree/Contents/link"
expect fail tree_symlink with owner clean_tree "$work/tree"
rm "$work/tree/Contents/link"
chmod g+w "$work/tree/Contents"
expect fail tree_group_write with owner clean_tree "$work/tree"
chmod g-w "$work/tree/Contents"
chmod 4755 "$work/tree/Contents/MacOS/plugin"
expect fail tree_setuid with owner clean_tree "$work/tree"
chmod 755 "$work/tree/Contents/MacOS/plugin"
expect pass tree_clean_again with owner clean_tree "$work/tree"

authdb="$work/auth.db"
sqlite3 "$authdb" "create table rules (id integer primary key, name text not null unique);"
state_is() { [[ "$(right_state)" == "$1" ]]; }
expect pass right_absent state_is absent
sqlite3 "$authdb" "insert into rules (name) values ('$mine');"
expect pass right_present state_is present
authdb="$work/no-such.db"
expect fail right_unknown_missing_db right_state
authdb="$work/bad.db"
sqlite3 "$authdb" "create table other (name text);"
expect fail right_unknown_bad_schema right_state
fake sqlfail sqlite3 'exit 1'
authdb="$work/auth.db"
expect fail right_unknown_sqlite_error with sqlfail right_state

run="$work/run"
scenario() {
    rm -rf "$run" && mkdir -p "$run/plugin/Contents"
    plugin="$run/plugin"
    backup="$work/backup.plist"
    authdb="$run/auth.db"
    sqlite3 "$authdb" "create table rules (id integer primary key, name text not null unique); insert into rules (name) values ('$mine');"
    cp "$1" "$run/live.plist"
    : > "$run/calls"
}
security() {
    echo "$*" >> "$run/calls"
    case "$1 $2" in
        "authorizationdb read") cat "$run/live.plist" ;;
        "authorizationdb write")
            [[ -e "$run/write-fails" ]] && return 1
            [[ -e "$run/write-garbles" ]] && { cat > /dev/null; cp "$work/drift.plist" "$run/live.plist"; return 0; }
            cat > "$run/live.plist"
            ;;
        "authorizationdb remove")
            [[ -e "$run/remove-fails" ]] && return 1
            [[ -e "$run/remove-lies" ]] || sqlite3 "$authdb" "delete from rules where name = '$3';"
            ;;
    esac
}
root_file() { [[ "$1" == "$backup" ]]; }
kept() { [[ -d "$plugin" ]] && ! grep -q 'remove' "$run/calls"; }
right_kept() { [[ -d "$plugin" ]]; }
uninstalled() { [[ ! -e "$plugin" ]] && state_is absent && same_policy "$run/live.plist" "$backup"; }

scenario "$work/installed.plist"
uninstall_locked_use > /dev/null
echo "uninstall_status=$?"
expect pass uninstall_ok_effects uninstalled
scenario "$work/drift.plist"
uninstall_locked_use 2>/dev/null
expect pass refused_drift_keeps_all kept
scenario "$work/installed.plist"
touch "$run/write-fails"
uninstall_locked_use 2>/dev/null
expect pass failed_restore_keeps_all kept
scenario "$work/installed.plist"
touch "$run/write-garbles"
uninstall_locked_use 2>/dev/null
expect pass unverified_restore_keeps_all kept
scenario "$work/installed.plist"
authdb="$work/no-such.db"
uninstall_locked_use 2>/dev/null
expect pass unknown_right_keeps_plugin kept
scenario "$work/installed.plist"
with sqlfail uninstall_locked_use 2>/dev/null
expect pass sqlite_error_keeps_plugin kept
scenario "$work/installed.plist"
touch "$run/remove-fails"
uninstall_locked_use 2>/dev/null
expect pass failed_remove_keeps_plugin right_kept
scenario "$work/installed.plist"
touch "$run/remove-lies"
uninstall_locked_use 2>/dev/null
expect pass right_still_present_keeps_plugin right_kept
scenario "$work/installed.plist"
with parse uninstall_locked_use 2>/dev/null
expect pass parse_error_keeps_all kept

[[ "$failed" == 0 ]] && echo "policy check PASS" || { echo "policy check FAIL"; exit 1; }
