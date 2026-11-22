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
database. It must restore the original rule, including the supported OpenAI
and macOS login alternatives when present, and remove the HyperNeo right and
plugin. If removal or restoration fails, the plugin must stay in place.
Pass ends with `uninstall check PASS`.

## Attended smoke

On an authorized test Mac, start a single copy of the updated signed Desktop.
Confirm that there is one HyperNeo menu bar icon. Open its menu and confirm
that **Remove Locked Use…** appears if the old plugin is present, then dismiss
the menu. Leave the installed authorization rule in place for the lock test.

Have the owner lock the Mac. Request a Desktop action and record that it
returns `screen_locked` without dispatching. Stop that worker and confirm with
the owner that the Mac remains locked. Have the owner enter the first few
characters of their password without submitting it and confirm it remains
locked. The owner then clears the field and authenticates normally. Record
only the lock states, dispatch result and whether normal unlock succeeded.
