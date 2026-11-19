# Desktop grant approval

The signed Desktop host refuses a verified app without a
grant, opens its own "Allow HyperNeo to control an app?" dialog, and records the
grant in its private keychain group only after a click on Allow. See
`docs/design/desktop-grant-approval.md`.

Unsigned fixture host (also runs in CI): the grant store is unreadable, so every
call returns `guards_unavailable`, forged answer fields and approve actions are
refused, and no dialog opens.

The fake owner and fake driver exercise dispatch without a signed host:

```bash
cargo rustc --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml \
  --bin desktop-driver-fixture -- --cfg test
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture \
  -k owner_approval_covers -k owner_decline_is -k owner_wait_is -k simultaneous_classes
```

Pass means four tests report `OK`: one approval covers pointer and keyboard,
concurrent requests share a dialog, decline and timeout return to the caller,
and a targetless window listing reaches the fake driver. This does not verify
the signed host or the real dialog.

```bash
cargo rustc --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml \
  --bin desktop-driver-fixture -- --cfg test
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture -k grant -k answer -k owner_yes -k dialog_names -k dialog_puts -k overlapping -k strand -k itself
```

Signed host, on a Mac with the Developer ID identity in its keychain and the
Developer ID profile for `io.hyperneo.app` (the release secret
`APPLE_DESKTOP_PROVISIONING_PROFILE`, base64-decoded):

```bash
APPLE_SIGNING_IDENTITY=<identity name or SHA-1> \
  bash .claude/skills/verify/desktop-grant-approval.sh "$RUN/evidence" <profile>
```

Pass means `grant-approval.txt` ends in `OK` with `signed_host=True`, the
same-user keychain add is refused, and approval covers both pointer and keyboard
for the same app. Decline applies to the app for ten minutes. The tests answer
the dialog through the fixture seam and remove their fixture grants; the real
dialog also needs an attended check.

For the attended check, use a disposable target and a real worker client. Answer
Allow near the end of the 45-second owner wait and exercise a slow driver call.
Record the client's request timeout, the reply or timeout, and whether input was
issued after the client stopped waiting. Do not retry input while its outcome is
unknown. This timing and the signed-host dialog remain unverified until observed.

To see the real dialog, start the signed host directly, send
`{"action":"fixture-dialog","worker":"w","tool":"real"}` and then a `resolve`
for `click` on Finder's pid to `desktop/control.sock`. The dialog stays open
until someone clicks a button; quitting the host closes it. It sends no input.
