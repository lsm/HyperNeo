# Desktop grant approval

The signed Desktop host decides who may record a desktop control grant. A grant covers one app's exact signing requirement and all action classes (observe, launch, pointer and keyboard).

## Decision

The owner approves a grant in a native dialog that the signed Desktop host shows itself. The answer is not relayed through the daemon or a paired device.

The earlier plan had the host accept the paired owner's card answer delivered by the daemon. That does not hold against a same-user worker. The host's control socket accepts any same-user connection, the host can attach to a daemon it did not start, and a same-user process can read the local human credential or write the daemon database. Any answer that only reaches the host through the daemon could be forged.

## Flow

1. A worker call resolves to a verified app and action class with no grant. The host opens one modal dialog per app. The call has a 20-second deadline for approval and dispatch.
2. The dialog uses the verified app’s icon as its own and names the app; it follows the Mac’s language (Chinese or English). "Allow <App>" is the rightmost default button (Return), followed by "Allow all apps" where eligible and "Don't Allow" (Escape).
3. Allow records the app-wide grant in the host's private keychain group. Allow all apps records one device-wide grant. Listed terminals, editors, automation tools and password managers, along with Keychain Access and System Settings, still require individual grants. A decline records no grant and returns `owner_declined` for that app for ten minutes. A pending answer returns `waiting_for_owner` after the wait expires.
4. An allowed call checks the target and deadline again before dispatch. If approval arrives after the deadline, it records the grant for the next call and never dispatches the expired call.

Existing per-class grants do not authorize the broader app-wide grant. Owners are asked again for each app; the old keychain items remain in place.

Driver startup already in progress can finish after the deadline so that its resources are cleaned up safely; the expired call still does not dispatch. The signed-host timing remains unverified.

The control socket has no answer or approve action, and requests with unknown fields are rejected. A worker therefore cannot submit, replay or reuse an answer. The host never offers a grant for its own app and refuses it with `app_not_grantable`, so driver input cannot be pointed at its own dialog.

## Limits of this slice

- The dialog is English only. If the host cannot verify the display metadata, the bundle ID also serves as the app name.
- The exception list matches known bundle IDs and vendor prefixes. Other apps with shells or password access can inherit the global grant if their bundle IDs are outside that list.
- A grant lasts until its keychain item (service `io.hyperneo.desktop.grant`) is removed. There is no revoke control in the app yet, so the dialog does not promise one.
- The dialog promises only the checks that exist today: the verified app and the supported actions. Focus and idle checks at input time come in a later slice.
