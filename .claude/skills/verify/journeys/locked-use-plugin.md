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
another identifier), then `unlock_diagnostics ax_trusted=0` and `ended not_locked accessibility_required
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
(the click shows nothing), `reveal=owner_input` with `ended local_input` (owner
input during the lookup stops the click), and after the click the same
`owner_input` and `ended local_input` with no submit (owner input during the
field's value set stops the arming), then `guardian reveal check PASS (5
cases)`. In an attended run the same tokens appear in the `unlock_diagnostics` line
of `HyperNeo.log`: `reveal=clicked` followed by `field_found=1` means the click
worked; `reveal=no_user`, `no_prompt` means the lock-screen tree differs;
`field_found=0` with `reveal=clicked` on every try means this Mac's login window
ignored the HID-tap click too.

## Release and suppression regression checks

Run the native fixture on a macOS build host. It injects the lock state and
lock request into the guardian's real exit path. It neither starts Desktop nor
changes the host's lock state.

```bash
bash packages/desktop/locked-use/check-release.sh
mkdir -p packages/desktop/src-tauri/binaries
touch "packages/desktop/src-tauri/binaries/hyperneo-$(rustc --print host-tuple)"
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml --lib locked_use::
```

The fixture checks that after owner input and relock the guardian stays alive
through the cover handoff interval. It also checks delayed unlock, a lock request
at the roughly five-second cap with no observed unlock, and exit with
`relock_failed` if the lock flag never returns by the ten-second release deadline.
The last case exercises the real authorization listener: an armed guardian
grants once, then refuses after an answered Allow or owner input. All five cases
end in `guardian release check PASS`. The lock flag does not show when the lock
screen draws. The guardian holds the covers for 750 ms after seeing it, within
the release deadline. Check the visible handoff in the attended run.
The Desktop tests cover refusal while a guardian is active or releasing,
suppression on a locked launch and after owner input or a crash, and admitting
workers again after an unlock.

## Attended signed Desktop checks

Use a signed Apple Silicon build on an Apple Silicon Mac and a signed Intel
build on an Intel Mac. Run each with the owner present, Locked Use installed
alongside OpenAI, and Accessibility and Input Monitoring granted. Save the
active unlock rule before and after. Launch Desktop while unlocked or unlock it
manually once if it was launched from a locked screen. When inducing owner input,
use the physical keyboard or pointing device.

Retain the Desktop log entries prefixed `Locked Use`, which include
`allow_answered`, `owner_input`, the guardian's `ended` reason and suppression
transitions. Record the visible lock and unlock states alongside those entries.

For an attended Desktop startup, check that `HyperNeo.log` records one
`Locked Use guardian: unlock_diagnostics` line before `unlocked` or `ended`.
It gives the Accessibility trust result, loginwindow PID (0 if absent), wake
status, and the numeric results of the AX calls in each try in call order.
`plugin_request_seen` reports whether an authorization request reached the
guardian socket. Compare with the macOS unified log for subsystem
`io.hyperneo.locked-use`, category `plugin`, which records invocations even if
they never reach the guardian. The diagnostics contain no UI values or input.

1. With the Mac locked, have a worker perform a real Calculator action and read
   the result back through Desktop. Check the blue cover. Stop the worker and
   confirm the Mac relocks and the guardian exits cleanly.
2. Repeat with input during startup, under the cover, and immediately after
   relock while the guardian is still exiting. Use the mouse and one or two
   password characters, first without Return and then with Return. Confirm that
   the guardian disarms and the log records zero further HyperNeo Allow replies
   until a normal manual unlock. With an external display attached, watch both
   displays from owner input until the lock screen takes over. There should be
   no desktop flash on either display. Check the same handoff for idle expiry
   and for an orderly stop or guardian stdin close.
3. Request a second worker while the first owns the Mac and again while it is
   releasing. Confirm both requests are refused. Interrupt a session with
   owner input and immediately request another session. Confirm refusal and zero
   approvals. After manual unlock, run two clean sessions without owner input
   and confirm each works and relocks.
4. Confirm the full password unlocks normally with Locked Use idle and while
   suppressed, clearing suppression. Confirm OpenAI Locked Use works before a
   HyperNeo session, during HyperNeo suppression and after a HyperNeo session.
   During suppression, confirm there are no HyperNeo Allow replies and that
   OpenAI relocks normally. Compare the saved rule with the active rule.
