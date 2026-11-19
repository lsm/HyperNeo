# Desktop grant approval

The signed Desktop host decides who may record a desktop control grant. A grant covers one app's exact signing requirement and all action classes (observe, launch, pointer and keyboard).

## Decision

The owner approves a grant in a native dialog that the signed Desktop host shows itself. The answer is not relayed through the daemon or a paired device.

The earlier plan had the host accept the paired owner's card answer delivered by the daemon. That does not hold against a same-user worker. The host's control socket accepts any same-user connection, the host can attach to a daemon it did not start, and a same-user process can read the local human credential or write the daemon database. Any answer that only reaches the host through the daemon could be forged.

## Flow

1. A worker call resolves to a verified app and action class with no grant. The host opens one modal dialog per app and waits up to 45 seconds for the answer.
2. The dialog names the app and the covered actions. "Allow" is the rightmost default button (Return); "Don't Allow" sits to its left (Escape).
3. Allow records the app-wide grant in the host's private keychain group. A decline records no grant and returns `owner_declined` for that app for ten minutes. A pending answer returns `waiting_for_owner` after the wait expires.
4. An allowed call checks the target again before dispatch. Approval alone does not send input.

Existing per-class grants do not authorize the broader app-wide grant. Owners are asked again for each app; the old keychain items remain in place.

The owner wait plus driver startup and the 30-second driver deadline can exceed a client's request timeout. An input sent after a client times out could be duplicated on retry. The attended signed-host journey must check this end to end; it remains unverified.

The control socket has no answer or approve action, and requests with unknown fields are rejected. A worker therefore cannot submit, replay or reuse an answer. The host never offers a grant for its own app and refuses it with `app_not_grantable`, so driver input cannot be pointed at its own dialog.

## Limits of this slice

- The dialog is English only. The host has no localization yet, and the bundle ID and action stay readable in any language.
- A grant lasts until its keychain item (service `io.hyperneo.desktop.grant`) is removed. There is no revoke control in the app yet, so the dialog does not promise one.
- The dialog promises only the checks that exist today: the verified app and the supported actions. Focus and idle checks at input time come in a later slice.
