#!/bin/bash
# Runs the real uninstall.sh entry point against fixtures, without root and
# without touching the Mac's authorization database. Only the paths in a copy of policy.sh
# are rewritten; security, id, chown, codesign and stat are fakes that act on the fixture.
# Usage: check-install.sh <stock rule plist>   (a saved `security authorizationdb read system.login.screensaver`)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
stock="${1:?stock rule plist}"
t="$(mktemp -d)"
trap 'rm -rf "$t"' EXIT
failed=0
user="$(id -un)"
group="$(id -gn)"
export FIXTURE="$t/fixture"

mkdir -p "$t/kit" "$t/bin"
cp "$here/uninstall.sh" "$here/policy.jxa" "$t/kit/"
sed -e "s|^plugin=.*|plugin=\"\$FIXTURE/plugins/HyperNeoLockedUse.bundle\"|" \
    -e "s|^backup=.*|backup=\"\$FIXTURE/support/screensaver-rule.backup.plist\"|" \
    -e "s|^authdb=.*|authdb=\"\$FIXTURE/auth.db\"|" \
    -e "s|^lock_dir=.*|lock_dir=\"\$FIXTURE/support/install.lock\"|" \
    "$here/policy.sh" > "$t/kit/policy.sh"
[[ "$(grep -c 'FIXTURE' "$t/kit/policy.sh")" == 4 ]] || { echo "path rewrite failed" >&2; exit 2; }

fake() { printf '#!/bin/bash\n%s\n' "$2" > "$t/bin/$1"; chmod +x "$t/bin/$1"; }
fake id '[[ "$1" == -u ]] && { echo 0; exit 0; }; exec /usr/bin/id "$@"'
fake chown 'exit 0'
fake rm '[[ -e "$FIXTURE/rm-fails" && "$1" == -rf ]] && exit 1; exec /bin/rm "$@"'
fake mktemp '[[ -e "$FIXTURE/mktemp-fails" ]] && exit 1; exec /usr/bin/mktemp "$@"'
fake stat "out=\"\$(/usr/bin/stat \"\$@\")\" || exit \$?; sed -e 's/^$user:$group:/root:wheel:/' -e 's/^$user:/root:/' <<< \"\$out\""
fake security 'f="$FIXTURE"; mine=io.hyperneo.locked-use.unlock
echo "$*" >> "$f/calls"
case "$1 $2" in
    "authorizationdb read")
        if [[ "$3" == "$mine" ]]; then cat "$f/right.plist" 2>/dev/null || { echo "NO (-60005)"; exit 1; }; else cat "$f/live.plist"; fi ;;
    "authorizationdb write")
        if [[ "$3" == "$mine" ]]; then
            cat > "$f/right.plist" && sqlite3 "$f/auth.db" "insert or ignore into rules (name) values ('"'"'$mine'"'"');"
        else
            [[ -e "$f/rule-write-fails" ]] && exit 1
            cat > "$f/live.plist"
        fi ;;
    "authorizationdb remove")
        [[ -e "$f/remove-fails" ]] && exit 1
        rm -f "$f/right.plist"; sqlite3 "$f/auth.db" "delete from rules where name = '"'"'$3'"'"';" ;;
esac'
export PATH="$t/bin:$PATH"

reset() {
    rm -rf "$FIXTURE" && mkdir -p "$FIXTURE/plugins" "$FIXTURE/support" || return
    sqlite3 "$FIXTURE/auth.db" "create table rules (id integer primary key, name text not null unique);" || return
    (
        . "$t/kit/policy.sh"
        cp "$stock" "$backup" || exit
        chmod 644 "$backup" || exit
        installed_from "$backup" "$FIXTURE/live.plist" || exit
        write_right_definition "$FIXTURE/legacy-right.plist" || exit
        mkdir -p "$plugin/Contents/MacOS" || exit
        echo fixture > "$plugin/Contents/MacOS/HyperNeoLockedUse" || exit
        security authorizationdb write "$mine" < "$FIXTURE/legacy-right.plist" || exit
        : > "$FIXTURE/calls"
    )
}
uninstall() { bash "$t/kit/uninstall.sh" > "$FIXTURE/out" 2>&1; }
expect() {
    local want="$1" name="$2" got
    shift 2
    if "$@"; then got=pass; else got=fail; fi
    echo "$name=$got"
    [[ "$got" == "$want" ]] || failed=1
}
right_row() { [[ "$(sqlite3 "$FIXTURE/auth.db" "select count(*) from rules;")" == 1 ]]; }
installed_state() {
    right_row && [[ -f "$FIXTURE/right.plist" && -f "$FIXTURE/plugins/HyperNeoLockedUse.bundle/Contents/MacOS/HyperNeoLockedUse" ]] \
        && grep -q io.hyperneo.locked-use.unlock "$FIXTURE/live.plist"
}
snapshot() { (cd "$FIXTURE" && find plugins support -print | sort && cat live.plist && sqlite3 auth.db "select name from rules;") 2>/dev/null; }
no_lock() { [[ ! -e "$FIXTURE/support/install.lock" ]]; }

removed_state() {
    ! right_row && [[ ! -e "$FIXTURE/plugins/HyperNeoLockedUse.bundle" ]] &&
        cmp -s "$stock" "$FIXTURE/live.plist" && no_lock
}

reset || exit 2
expect pass installed_fixture installed_state
expect pass uninstall uninstall
expect pass stock_restored removed_state

reset || exit 2
touch "$FIXTURE/remove-fails"
expect fail partial_uninstall uninstall
expect pass partial_uninstall_keeps_plugin eval '[[ -d "$FIXTURE/plugins/HyperNeoLockedUse.bundle" ]] && right_row && cmp -s "$stock" "$FIXTURE/live.plist"'
rm -f "$FIXTURE/remove-fails"
expect pass retry_uninstall uninstall
expect pass retry_restores_stock removed_state

reset || exit 2
mkdir "$FIXTURE/support/install.lock"
before="$(snapshot)"
expect fail uninstall_while_locked uninstall
expect pass locked_changed_nothing eval '[[ "$(snapshot)" == "$before" && ! -s "$FIXTURE/calls" ]]'
expect pass foreign_lock_kept eval '[[ -d "$FIXTURE/support/install.lock" ]]'

reset || exit 2
touch "$FIXTURE/mktemp-fails"
expect fail uninstall_mktemp_fails uninstall
expect pass mktemp_failure_releases_lock no_lock
expect pass mktemp_failure_keeps_install installed_state

reset || exit 2
touch "$FIXTURE/rule-write-fails"
expect fail restore_write_fails uninstall
expect pass restore_failure_keeps_install installed_state

[[ "$failed" == 0 ]] && echo "uninstall check PASS" || { echo "uninstall check FAIL"; exit 1; }
