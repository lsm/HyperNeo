# Desktop grant approval

The signed Desktop host refuses a verified app and action class without a
grant, opens its own "Allow HyperNeo to control an app?" dialog, and records the
grant in its private keychain group only after a click on Allow. See
`docs/design/desktop-grant-approval.md`.

Unsigned fixture host (also runs in CI): the grant store is unreadable, so every
call returns `guards_unavailable`, forged answer fields and approve actions are
refused, and no dialog opens.

```bash
cargo rustc --locked --manifest-path packages/desktop/tests/driver-host/Cargo.toml \
  --bin desktop-driver-fixture -- --cfg test
python3 packages/desktop/tests/worker-drivers.py \
  packages/desktop/tests/driver-host/target/debug/desktop-driver-fixture -k grant -k answer -k owner_yes
```

Signed host, on a Mac with the Developer ID identity in its keychain and the
Developer ID profile for `io.hyperneo.app` (the release secret
`APPLE_DESKTOP_PROVISIONING_PROFILE`, base64-decoded):

```bash
APPLE_SIGNING_IDENTITY=<identity name or SHA-1> \
  bash .claude/skills/verify/desktop-grant-approval.sh "$RUN/evidence" <profile>
```

Pass means `grant-approval.txt` ends in `OK` with `signed_host=True`, a
same-user keychain add returns -34018, a declined dialog records nothing, and an
allowed dialog grants only Finder/pointer. The tests answer the dialog through
the fixture seam and remove their fixture grants.

To see the real dialog, start the signed host directly, send
`{"action":"fixture-dialog","worker":"w","tool":"real"}` and then a `resolve`
for `click` on Finder's pid to `desktop/control.sock`. The dialog stays open
until someone clicks a button; quitting the host closes it. It sends no input.
