# Locked Use is disabled

On a test Mac, run the shipped native entry points from this checkout without
admin privileges, signing, GUI input or changes to the authorization database:

```bash
bash packages/desktop/locked-use/check-disabled.sh
```

Pass prints `guardian exit=2 output=ended disabled`,
`authorization mechanism=deny`, and an installer refusal, followed by
`Locked Use disabled: 3 entry points passed`. The guardian refusal occurs
before covering or interacting with the screen. The plugin callback must
deny even if an older installation still names the mechanism. Quit or stop
a worker through the usual Desktop controls. Locked Desktop dispatches
should return `screen_locked`.

## Existing installs

Desktop exposes **Remove Locked Use…** for existing installs. Without an
installed plugin it shows **Locked Use unavailable** as a disabled menu item.

Run the removal fixtures on macOS with a representative stock rule that has
class `rule`, the sole entry `use-login-window-ui`, and no `k-of-n` key:

```bash
bash packages/desktop/locked-use/check-install.sh "$RUN/stock.plist"
```

The fixture uses the real uninstaller with an isolated fake authorization
database. It must restore the stock rule, remove the legacy right and plugin,
and preserve the plugin if removing the legacy right or restoring the rule
fails. Pass ends with `uninstall check PASS`.

Attended smoke on an authorized test Mac with the updated signed Desktop:
use **Remove Locked Use…** if the old plugin is present and let the owner
handle the administrator prompt. Read `system.login.screensaver` before and
after removal and confirm the result matches the saved stock rule. With
the screen locked, request a Desktop action and verify that it returns
`screen_locked` without dispatching. Stop the worker and have the owner
confirm the Mac remains locked until their normal macOS authentication succeeds.
