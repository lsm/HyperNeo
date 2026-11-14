# Desktop grant approval

The signed Desktop host decides who may record a desktop control grant. A grant covers one app's exact signing requirement and one action class (observe, launch, pointer or keyboard).

## Decision

The owner approves a grant in a native dialog that the signed Desktop host shows itself. The answer is not relayed through the daemon or a paired device.

The earlier plan had the host accept the paired owner's card answer delivered by the daemon. That does not hold against a same-user worker. The host's control socket accepts any same-user connection, the host can attach to a daemon it did not start, and a same-user process can read the local human credential or write the daemon database. Any answer that only reaches the host through the daemon could be forged.

## Flow

1. A worker call resolves to a verified app and action class with no grant. The host refuses it with `app_action_not_authorized`.
2. The host opens one modal dialog for that app and class, unless one is already open. The dialog names the app's bundle ID and the action. "Don't Allow" is the default button.
3. Only a click on "Allow" records the grant in the host's private keychain group. A declined, dismissed or failed dialog records nothing. After a decline, the host shows no new dialog for that app and class for 10 minutes and refuses with `app_action_declined`, so worker retries cannot flood the owner.
4. The worker's refusal says approval is waiting on the Mac. The worker reports that through its normal blocker, so the Neo card only points the human to the Mac.
5. The next ordinary call checks the grant and every other guard again. Approval never runs input by itself.

The control socket has no answer or approve action, and requests with unknown fields are rejected. A worker therefore cannot submit, replay or reuse an answer. The host never offers a grant for its own app and refuses it with `app_not_grantable`, so driver input cannot be pointed at its own dialog.

Only the daemon asks the host to act. Today the worker's `desktop-mcp` process reaches the host only for the read-only `resolve` guard and has no input path at all: dispatch throws, so the proxy answers `driver_unavailable`. The forwarding action below takes input, so it moves behind the daemon: the proxy submits a call to the daemon's operations door and the daemon is the only client accepted for the dispatch action. The four layers below are what has to hold before that action exists.

## Host forwarding

The host already starts, stops and reports a driver, and resolves a verified app and action class for a call. What is missing is the action that forwards a resolved tool call to that driver. It is added only behind all four layers below, and no other action reaches a driver with input.

### 1. Only the daemon can open the port

The host accepts a control connection only from a client that proves possession of a port key. The key is a generic password item in the Data Protection keychain group the host already uses (`P5R65T296V.io.hyperneo.app`, from the signed entitlements), so only code signed for that team can reach the group at all. The key item carries a user-presence access control: even a team-signed process reads it only after the owner approves that read in the system prompt. The existing grant items use after-first-unlock protection with no presence flag, so they prove nothing here.

The daemon reads the key at connect and answers a fresh host nonce; the host refuses any connection without the correct answer. The worker's proxy never holds the key and never reads the group. A same-user process on the same account therefore cannot stand in for the daemon, which the 0700 directory and the socket's user ownership never prevented.

### 2. The daemon speaks only for an opted-in task

The daemon issues a forwarding token per call, and only when the target task's todo is in `doing` with desktop control on in `named`, the binding the proxy already resolves as `todo_id`, `worker_id` and `driver_instance_id`. The token names the task, the session, the target app (bundle ID plus its anchored signing requirement), the action class and a short expiry. The host checks the expiry and matches the token's task, session and app against the driver instance the request names.

A token is not a grant. A worker cannot mint one, widen one or reuse one for another app, session or task. The proxy has no route that carries a caller-supplied token.

### 3. The owner approves each app once

The existing dialog stays the only approval path, and a forwarding token must also match a stored grant. When a task first targets an app and class, the host refuses with `app_action_not_authorized` and opens the dialog; allow records the grant, decline records nothing and holds for 10 minutes. A token whose app or class has no stored grant is refused before the driver sees anything, even when the token is well formed and unexpired.

### 4. Every action is recorded, and input has no other route

The daemon writes one audit record per forwarded call: task, session, worker, driver instance, app, action class, tool, time, decision, result and whether the driver was reached. The host writes its own record for every dispatch it performs, refusals and driver errors included, from the verified token claims and what actually happened, so a daemon fault cannot hide an action.

Input reaches a driver only through the host's dispatch action, and dispatch writes its record before replying. There is no direct socket to the driver, no second entry point and no path that returns a result without a record.

## What this does not protect against

- **Code running as the daemon.** The daemon holds the port key and mints tokens. Whoever runs code as the daemon acts as the daemon, so this boundary stops a worker, not a compromised daemon.
- **A process that uses the daemon's own credentials.** A process that can read the local human credential and call the daemon's authenticated door is the daemon's client, not the host's. Port authentication does not raise that bar; it only keeps such a process from skipping the daemon.
- **A stolen signing identity.** The keychain group is scoped by team, so a different signer is refused. Someone who signs with HyperNeo's own Developer ID reaches the group; this design does not defend against that.
- **A grant already given.** Approval is per app and action class. The first task in an app asks; every later opted-in task in that app acts without a new dialog, and a token only proves which task it was. Per-task consent is not what this design gives.
- **Replay inside the expiry.** A leaked token can be replayed for the same task and app until it expires. Session and lease bounds shrink that window; they do not close it.
- **What the driver does after input.** These layers decide whether one tool call may be issued. They do not limit what an allowlisted tool does inside the app, and they do not cover file access a worker has without the host.
- **Values, screenshots and secrets.** Records carry identities, the tool name and the result; no typed values, no field contents and no images.
- **Other builds and machines.** Desktop control needs the signed host running with this build. Nothing here protects an install without the port key or with an unsigned host, which stay at `guards_unavailable`.

## Limits of this slice

- The dialog is English only. The host has no localization yet, and the bundle ID and action stay readable in any language.
- A grant lasts until its keychain item (service `io.hyperneo.desktop.grant`) is removed. There is no revoke control in the app yet, so the dialog does not promise one.
- The dialog promises only the checks that exist today: the verified app and the action class. Focus and idle checks at input time come in a later slice.
