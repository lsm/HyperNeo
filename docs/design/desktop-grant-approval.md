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

Only the daemon asks the host to act. Today the worker's `desktop-mcp` process calls the host's `resolve` guard itself, and `resolve` sends no driver input but can open the approval dialog; there is still no input path, because dispatch throws and the proxy answers `driver_unavailable`. The forwarding action below sends input, so every call moves behind the daemon: the proxy submits it to the daemon's operations door, the daemon does the `resolve` and the dispatch, and the daemon is the only client the host accepts for either.

## Host forwarding

The host already starts, stops and reports a driver, and resolves a verified app and action class for a call. What is missing is the action that forwards a resolved tool call to that driver. It is added only behind all four layers below, and no other action reaches a driver with input.

### 1. Only a daemon in the host's own bundle can open the port

The host accepts a control connection only from a client that proves possession of a port key. The key is a generic password item in the Data Protection keychain group the host already uses (`P5R65T296V.io.hyperneo.app`, from the signed entitlements), so only code signed for that team can reach the group at all. The key item carries a user-presence access control: even a team-signed process reads it only after the owner approves that read in the system prompt. The existing grant items use after-first-unlock protection with no presence flag, so they prove nothing here.

The daemon reads the key once and caches it in memory for its own lifetime; it does not read it again on later connections. The control socket serves one request per connection (`desktop_drivers.rs`), so a forwarded call opens a new connection, and a per-connect read would put an owner prompt in front of every call and contradict layer 3's "without asking again". The prompt therefore happens **once per daemon process start**, on the first host connection, and later connections answer each fresh host nonce from the cached key.

**Revocation.** Because each side keeps its copy in memory for its own lifetime, removing or replacing the key item does not by itself cut off a running pair: the daemon keeps answering the host's nonces from its cache and the host keeps accepting them, so the daemon **can keep working after removal**. Removal takes effect only at the next restart of one of them — a restarted daemon cannot read the removed item and refuses at its first connection, and a restarted host creates a new item whose answers a cache from the old one cannot match. The maximum delay between removal and refusal is therefore until the host or the daemon next restarts, whichever comes first; there is no expiry, no periodic re-read and no revoke action on the socket. See the limits list below.

The worker's proxy never holds the key and never reads the group. A same-user process without the key therefore cannot stand in for the daemon, which the 0700 directory and the socket's user ownership never prevented.

**Signing prerequisite.** The group is reachable only by a binary signed with that team's identity and the `keychain-access-groups` entitlement. Today only the app bundle carries it: `cua-driver-bundle.json` applies `SignedEntitlements.plist` to the bundle, and `tauri.conf.json` gives the `binaries/hyperneo` sidecar the plain `Entitlements.plist`. So forwarding needs the bundled sidecar signed with the group entitlement and a provisioning profile that allows it, which the build does not do yet. That is a prerequisite of this layer, not a follow-on.

**Attach-first.** The host calls a daemon "reachable" when two things hold: `runtime.json` — under `HYPERNEO_DATA_DIR`, or `~/.hyperneo` — parses as a descriptor with a port, and `GET {url}/` — the descriptor's advertised `url`, or `http://127.0.0.1:{port}` when it has none — returns a 2xx within six attempts 200ms apart, each attempt bounded by a 2s connect and 2s total timeout. That is the shipped probe in `lib.rs` (`read_runtime_descriptor`, `probe_daemon`). A descriptor that does not parse, or a probe that never gets a 2xx, is not reachable: the app ignores it and spawns its own sidecar.

An attached CLI or launchd daemon is not in the bundle and can never hold the group. **Proposed behavior, not shipped:** desktop control is unavailable in that state — `guards_unavailable` on every forwarding call, and `desktop.status` additionally explains that the running daemon was not started by this app.

Today `desktop.status` reads `unavailable` when the host app's control socket does not answer within its 1s connect check (`status-operation.ts`). That is a fact about the socket, not about the app: the app binds it at startup whether it later attaches or spawns its sidecar, so the cause can be that the app has quit, that it is still starting before the socket is bound, that the socket is wedged, or simply that this probe timed out. A failed probe while the app is running is therefore possible. The human's remedy is to restart HyperNeo Desktop and retry; the extra explanation above is proposed behavior, not shipped wording.

Desktop control then turns on only against the app's own signed sidecar. Falling back to a weaker check for an attached daemon is not an option, because that check is what keeps a worker's proxy from standing in for the daemon.

### 2. The daemon speaks only for an opted-in task

The daemon issues a forwarding token per call, and only when the target task's todo is in `doing` with desktop control on in `named`, the binding the proxy already resolves as `todo_id`, `worker_id` and `driver_instance_id`. The token names the task, the session, the target app (bundle ID plus its anchored signing requirement), the action class and a short expiry.

The host checks the expiry, matches the token's task, session and app against the driver instance the request names, and matches the token's class to the class it resolves for the actual call. A token asking for `pointer` does not dispatch a call the host classifies as `keyboard`; the mismatch refuses as `target_mismatch`. The class the host resolved is the one the grant check uses, so a token cannot name a granted class to send an ungranted one.

A token is not a grant. A worker cannot mint one, widen one or reuse one for another app, session or task. The proxy has no route that carries a caller-supplied token.

### 3. The owner approves each app once

The existing dialog stays the only approval path, and a forwarding token must also match a stored grant. When a task first targets an app and class, the host refuses with `app_action_not_authorized` and opens the dialog; allow records the grant, decline records nothing and holds for 10 minutes. The grant check uses the app and the class the host resolved for this call, never the token's claims, so a token whose app or class has no stored grant is refused before the driver sees anything, even when the token is well formed and unexpired.

### 4. Every action is recorded, and input has no other route

Each call that gets past the pre-dispatch commit has one durable row, written in two phases. The row is not a single write that both gates dispatch and reports its result; the outcome fields stay empty until the dispatch has finished.

1. **Pre-dispatch.** Before any token is sent, the daemon commits the row with task, session, worker, driver instance, app, action class, tool, time and the call ID, a phase of `pending`, and the outcome fields — decision, result, reached-the-driver, duration — left empty. The commit must succeed first; if it fails, nothing is dispatched, nothing is recorded, and the worker gets the refusal.
2. **Finalize.** When the host returns, the daemon writes those outcome fields into the same row, committed before the worker's reply is written. If finalize fails, that committed row stays `pending` and the reply is withheld: the worker gets an error that the outcome is unrecorded rather than a result. A row still in `pending` with empty outcome fields therefore always means the outcome was never recorded, and a reader never sees an outcome that was not written.

If the pre-dispatch commit fails, nothing is recorded — no daemon row and no host record — nothing is dispatched, and the worker gets the refusal; a check that ends the call before that commit (no opt-in, no token) does the same. A refusal that happens after the row is committed — a class or target mismatch the host rejects, a store or grant refusal — ends that row as `refused` with no host record.

Only a call the host actually dispatched ends in phase `finalized` with populated outcome fields and the host's own record, which the host writes and commits before returning, so a daemon fault cannot hide an action. Input reaches a driver only through the host's dispatch action: there is no direct socket to the driver and no second entry point.

## What this does not protect against

- **Code running as the daemon.** The daemon holds the port key and mints tokens. Whoever runs code as the daemon acts as the daemon, so this boundary stops a worker, not a compromised daemon.
- **A process that uses the daemon's own credentials.** A process that can read the local human credential and call the daemon's authenticated door is the daemon's client, not the host's. Port authentication does not raise that bar; it only keeps such a process from skipping the daemon.
- **A stolen signing identity.** The keychain group is scoped by team, so a different signer is refused. Someone who signs with HyperNeo's own Developer ID reaches the group; this design does not defend against that.
- **A grant already given.** Approval is per app and action class. The first task in an app asks; every later opted-in task in that app acts without a new dialog, and a token only proves which task it was. Per-task consent is not what this design gives.
- **Replay inside the expiry.** A leaked token can be replayed for the same task and app until it expires. Session and lease bounds shrink that window; they do not close it.
- **The port key while the daemon runs.** It is cached after one approved read, so a process that can read the daemon's memory for the rest of that process's life can act as the daemon. Removing the key item does not revoke a running pair either: both sides keep their copies until one of them restarts, and only then is the next connection refused or asked again.
- **What the driver does after input.** These layers decide whether one tool call may be issued. They do not limit what an allowlisted tool does inside the app, and they do not cover file access a worker has without the host.
- **Values, screenshots and secrets.** Records carry identities, the tool name and the result; no typed values, no field contents and no images.
- **A daemon this app did not start.** An attached CLI or launchd daemon cannot hold the port key, so desktop control stays off while one is attached. The signed sidecar and its signing prerequisite are not an edge case here; they are what the feature runs on.
- **Builds without the signed sidecar.** Nothing here protects an install without the port key or with an unsigned host, which stay at `guards_unavailable`.

## Limits of this slice

- The dialog is English only. The host has no localization yet, and the bundle ID and action stay readable in any language.
- A grant lasts until its keychain item (service `io.hyperneo.desktop.grant`) is removed. There is no revoke control in the app yet, so the dialog does not promise one.
- The dialog promises only the checks that exist today: the verified app and the action class. Focus and idle checks at input time come in a later slice.
