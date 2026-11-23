# Locked Use authorization plugin

Locked Use adds one alternative to the screen-unlock right
`system.login.screensaver`: the signed plugin's mechanism
`HyperNeoLockedUse:unlock,privileged`. The rule becomes "any one of" that right
and the original unlock alternatives, so the login window and any supported
OpenAI unlock rule stay in place. The mechanism allows only when a process signed as
`io.hyperneo.locked-use` by team P5R65T296V, running as the console user, answers
on `/private/tmp/io.hyperneo.locked-use.<uid>.sock`. Anything else denies.

Plugin decision, on a Mac with the Developer ID identity in its keychain. No root,
no lock, and no change to the authorization database:

```bash
RUN=$(mktemp -d)
bash packages/desktop/locked-use/build.sh "$RUN"
bash packages/desktop/locked-use/check-plugin.sh "$RUN"
```

Pass prints `none=deny adhoc=deny other=deny guardian-silent=deny guardian-hangup=deny
guardian=allow` and `plugin check PASS`: no server, an ad-hoc signed server and a server
signed with another identifier are refused; a guardian that never answers or hangs up
is refused within about a second without crashing; only an answering guardian is allowed.

Install and removal checks, also without root or any change. They run on copies of the
rule, a fixture rules database and a fixture plugin folder, and inject tool failures;
every injected failure must refuse and leave the plugin and its right in place:

```bash
security authorizationdb read system.login.screensaver > "$RUN/stock.plist"
bash packages/desktop/locked-use/check-policy.sh "$RUN/stock.plist"
bash packages/desktop/locked-use/check-install.sh "$RUN/stock.plist"
```

Run them before installing, or pass a saved stock rule. Pass ends `policy check PASS` and
`install check PASS`. The second runs the real install.sh and uninstall.sh with only their
paths moved into a fixture: install, reinstall, uninstall, reinstall after an uninstall that
could not remove the right (refused, nothing changed), a held lock (refused), two installs
at once (the second is refused) and a failed install (rolled back). Install and uninstall
hold one lock from the first read to the end, so they never run at the same time.
The OpenAI fixture starts with the OpenAI rule and the login window, with one
success required. It checks that installation keeps both in order, uninstall
restores the exact original policy, and a stricter threshold is refused.

Install and removal change the Mac's unlock rule and need the owner's admin
password. Run them only on a test Mac or with the owner's explicit approval, and
save the rule first:

```bash
security authorizationdb read system.login.screensaver > "$RUN/before.plist"
sudo bash packages/desktop/locked-use/install.sh "$RUN/HyperNeoLockedUse.bundle"
sudo bash packages/desktop/locked-use/uninstall.sh
security authorizationdb read system.login.screensaver > "$RUN/after.plist"
diff <(plutil -extract rule xml1 -o - "$RUN/before.plist") <(plutil -extract rule xml1 -o - "$RUN/after.plist")
```

Install prints the rule array with `io.hyperneo.locked-use.unlock` first;
uninstall prints the original array and the diff is empty. Install refuses while the Locked Use right is still defined or its state is unknown (run uninstall first), and refuses any rule
other than the stock `class rule` with exactly `use-login-window-ui` or the
OpenAI remote unlock rule followed by `use-login-window-ui` with `k-of-n` equal to 1. It copies the plugin
without ACLs or extended attributes, verifies the tree is root-owned and writable only by
root and is the Developer ID plugin `io.hyperneo.locked-use.plugin`, and restores the
original rule if any later step fails; if that restore does not read back, it says so and
leaves the plugin and right in place. Uninstall needs the root-owned original backup and a live
rule equal to the backup, with or without Locked Use; anything else, including any tool
error, is refused unchanged. It verifies
the restored rule before removing the right, and deletes the bundle only after the
authorization database shows the right gone. The only extended attribute allowed on the
plugin is the exact name `com.apple.provenance`, which macOS attaches to files written by
tracked apps, including this copy, and which `xattr -d` does not remove; `check-policy.sh`
shows both and rejects look-alike names. Install also verifies the right reads back with
the privileged mechanism, and its rollback deletes the bundle only after the right is
proven gone. After install, lock the Mac and
unlock it with the password once to confirm the normal path still works.

Signed Desktop builds ship the plugin and these four scripts in
`HyperNeo.app/Contents/Resources/locked-use/`, so the same install runs from the app:
`sudo bash <app>/Contents/Resources/locked-use/install.sh <app>/Contents/Resources/locked-use/HyperNeoLockedUse.bundle`.
`verify-macos-bundle.sh` fails the release build unless the shipped plugin is the Developer ID
`io.hyperneo.locked-use.plugin` with the hardened runtime and every script matches the repo copy.

On a signed Desktop build with these resources, launch a single copy of the app
and confirm there is one HyperNeo icon in the macOS menu bar. Right-click it and
check for **Install Locked Use…** between **Hide HyperNeo** and **Quit**, or
**Remove Locked Use…** if the plugin is installed. Dismiss the menu to check the
label without changing the Mac's unlock rule.

## Guardian

The guardian `hyperneo-locked-use` (identifier `io.hyperneo.locked-use`) is the only
process the plugin answers. It ships as `HyperNeo.app/Contents/MacOS/hyperneo-locked-use`
and starts only when its parent is signed `io.hyperneo.app` by team P5R65T296V, the
plugin is installed, the screen is locked and it has Accessibility. While running it
covers every display with "HyperNeo is using this Mac", keeps the display awake, and
locks again on keyboard, mouse or trackpad input, on "stop" or EOF on stdin, or when no
stdin line arrives for its idle seconds (first argument, default 60).

Start gates, with the screen unlocked. Nothing is covered or unlocked:

```bash
bash packages/desktop/locked-use/check-guardian.sh "$RUN"
```

Pass prints `ended untrusted_owner` twice (no launcher, and a launcher signed with
another identifier), then `ended not_locked accessibility_required
input_monitoring_required` (with `not_installed` first when the plugin is absent) from a
copy that holds no privacy grants, and `guardian check PASS`. The screen must be
unlocked for the `not_locked` token: with the screen locked the third start omits it
and the check fails on the environment, not the guardian.

Cover geometry, headless. This runs the guardian's cover and relock paths with
synthetic screens, windows and lock state. It opens no real windows:

```bash
bash packages/desktop/locked-use/check-cover.sh
```

Both covers must match their full screen frames before and after the larger
display changes size and moves to a negative origin. If the replacement window
reports a smaller frame, the guardian must relock and print
`ended cover_mismatch` without a second `covered 2` line. Pass prints
`guardian cover check cases=2 failures=0`.

Hidden password field, headless. While Touch ID can unlock, the login window keeps
`UserPasswordTextField` out of its Accessibility tree and shows only "Touch ID or
Enter Password", so the guardian has nothing to submit. Its answer is to click that
prompt label (the one unnamed static text just below `FocusedUser`) at the HID tap,
the way a physical click reaches the lock screen; a click posted to loginwindow's pid
alone is ignored. The click's events carry the guardian as their source, never the
HID source 0 that the owner-input tap reads as the owner, so the guardian cannot
relock on its own click. Nothing is typed. Check the lookup, the click and the
owner-input stop, without touching the real lock screen:

```bash
bash packages/desktop/locked-use/check-reveal.sh "$RUN"
```

Pass prints `click hid 720,530` then `submitted` (the field came back and was
submitted), `prompts=2 reveal=no_prompt` with no click and `ended unlock_failed`
(two candidate labels, nothing clicked), `reveal=clicked` with `ended unlock_failed`
(the click shows nothing), and `reveal=owner_input` with `ended local_input` (owner
input during the lookup stops the click), then `guardian reveal check PASS (4
cases)`. In an attended run the same tokens appear in the `unlock_diagnostics` line
of `HyperNeo.log`: `reveal=clicked` followed by `field_found=1` means the click
worked; `reveal=no_user`, `no_prompt` means the lock-screen tree differs;
`field_found=0` with `reveal=clicked` on every try means this Mac's login window
ignored the HID-tap click too.

Desktop gate and crash relock, with no GUI. One task owns Locked Use and handles every
event in order: Idle, Starting (guardian spawned, waiting up to 15 seconds for `unlocked`),
Owned (only that worker may act; each of its calls keeps the guardian alive, idle 120
seconds) and Releasing (guardian input closed, until the guardian process exits). Other
workers get `screen_locked` outside Idle. A start is refused while any call is acting, after
an unsettled call or unconfirmed stop, or for a stopped worker. Stopping the owner returns
only after its guardian has exited. Desktop relocks when the guardian exits uncleanly after
covering, such as when it is killed:

```bash
mkdir -p packages/desktop/src-tauri/binaries
touch "packages/desktop/src-tauri/binaries/hyperneo-$(rustc --print host-tuple)"
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml --lib locked_use
```

Pass runs 19 tests: killed or relock-failed after covering relocks once; a clean end or a
start-gate refusal does not; a second worker is refused while the owner holds the Mac, even
when its call was admitted earlier, and is admitted only after the guardian has exited; no
start while a call is acting, and retiring an acting worker never waits on a start; an
unsettled call blocks starts until its driver is confirmed stopped; a stop or a cancel during
startup releases only after the guardian exits, a call cancelled while being admitted or ending after its worker retired never blocks a start, a start cancelled after the unlock releases the Mac, and a stopped worker never takes the Mac; a
refusing or missing guardian leaves the call refused.

Live run, on a Mac with the plugin installed and the owner present. Start it, then lock
the Mac with Control-Command-Q within 20 seconds:

```bash
{ sleep 50; echo stop; } | { sleep 20; "$RUN/launch-app" "$RUN/hyperneo-locked-use" 120; } > "$RUN/live.log" &
```

Within a few seconds of the lock the Mac unlocks behind a blue cover on every display
that reads "HyperNeo is using this Mac" and the start time. `pmset -g assertions` over ssh
lists `HyperNeo Locked Use cover` under PreventUserIdleDisplaySleep. About 30 seconds
later the Mac locks again and `live.log` ends `ended stopped`. Repeat and touch the
trackpad while covered: the Mac locks at once and the log ends `ended local_input`.
