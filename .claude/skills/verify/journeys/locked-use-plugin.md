# Locked Use authorization plugin

Locked Use adds one alternative to the screen-unlock right
`system.login.screensaver`: the signed plugin's mechanism
`HyperNeoLockedUse:unlock,privileged`. The rule becomes "any one of" that right
and the original `use-login-window-ui`, so password and Touch ID unlock stay as
they were. The mechanism allows only when a process signed as
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

Install prints the rule array `io.hyperneo.locked-use.unlock, use-login-window-ui`;
uninstall prints the original array and the diff is empty. Install refuses while the Locked Use right is still defined or its state is unknown (run uninstall first), and refuses any rule
other than the stock `class rule` with exactly `use-login-window-ui`, copies the plugin
without ACLs or extended attributes, verifies the tree is root-owned and writable only by
root and is the Developer ID plugin `io.hyperneo.locked-use.plugin`, and restores the
stock rule if any later step fails; if that restore does not read back, it says so and
leaves the plugin and right in place. Uninstall needs the root-owned stock backup and a live
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
