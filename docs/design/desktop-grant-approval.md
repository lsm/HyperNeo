# Desktop grant approval

The signed Desktop host decides who may record a desktop control grant. A grant covers one app's exact signing requirement and one action class (observe, launch, pointer or keyboard).

## Decision

The owner approves a grant in a native dialog that the signed Desktop host shows itself. The answer is not relayed through the daemon or a paired device.

The earlier plan had the host accept the paired owner's card answer delivered by the daemon. That does not hold against a same-user worker. The host's control socket accepts any same-user connection, the host can attach to a daemon it did not start, and a same-user process can read the local human credential or write the daemon database. Any answer that only reaches the host through the daemon could be forged.

## Flow

1. A worker call resolves to a verified app and action class with no grant. The host refuses it with `app_action_not_authorized`.
2. The host opens one modal dialog for that app and class, unless one is already open. The dialog names the app's bundle ID and the action. "Don't Allow" is the default button.
3. Only a click on "Allow" records the grant in the host's private keychain group. A declined, dismissed or failed dialog records nothing.
4. The worker's refusal says approval is waiting on the Mac. The worker reports that through its normal blocker, so the Neo card only points the human to the Mac.
5. The next ordinary call checks the grant and every other guard again. Approval never runs input by itself.

The control socket has no answer or approve action, and requests with unknown fields are rejected. A worker therefore cannot submit, replay or reuse an answer. The host never offers a grant for its own app, so driver input cannot be pointed at its own dialog.
