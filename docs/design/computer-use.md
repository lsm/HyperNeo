# Computer use: HyperNeo sessions first (minimal)

Replaces the four-layer design in lsm/HyperNeo#10632. Scope: HyperNeo's own sessions only. Codex and Claude Code workers come later.

## Problem

A worker's desktop tool call never reaches a driver. The `desktop-mcp` proxy plans the call and then `dispatch` throws `driver_unavailable` (`packages/cli/src/desktop-mcp.ts`). The host app's control socket has `start`, `stop`, `status` and `resolve`, but no action that sends input (`desktop_drivers.rs`).

#10632 adds a keychain port key, a signed sidecar, per-call tokens and a two-phase audit, and it turns the feature off for any daemon the app did not spawn. A daemon run as a launchd service, a common setup, therefore never gets it.

## Why HyperNeo sessions make this small

A HyperNeo session already calls daemon operations in process: every session gets the `hyperneo-operations` MCP server unless `operationTools` is off (`query-options-builder.ts`). The daemon resolves the caller itself, so a session cannot claim to be another one. No proxy process and no new channel are needed.

## Design

1. **One daemon operation, `desktop.call {tool, args}`, in-process callers only.** Its policy admits only a caller with `source: 'mcp'`, a session, a role (a todo worker's own `universal_read` included) and no `principal`, which is what a session's in-process operations server produces (`agent-session.ts`). RPC callers and the session door (`session-door.ts`, which sets a principal and no role, and whose allowlist does not include `desktop.call`) are refused before any host request. The caller session comes from that identity, never from the input.
2. **One superpipe pipeline in the operation, daemon checks first:**
   - read facts: the caller's approved, unfinished todo bindings on open asks (`readDesktopTodos` / `desktopOptIn`). Prefer a doing todo; otherwise select the sole opted-in todo. The input schema comes from `tool-catalog.json`, so an unlisted tool or bad arguments fail validation and `operations.describe` lists every tool;
   - `decideDesktopCall(facts)`: a pure function that returns `send` or a refusal. It distinguishes a finished opted-in todo (`todo_not_active`) and multiple opted-in candidates with none doing (`todo_ambiguous`) from `desktop_not_enabled`. The host is not contacted on a refusal, so no owner dialog can open for a call the daemon would refuse;
   - edge: on `send`, one host `dispatch` request (below);
   - edge: write one audit row from the host's reply (todo, session, tool, app, class, decision, reason, dispatched, time).
3. **One host request, `dispatch {worker_id, work_dir, tool, args}`.** The control socket keeps its one-request, one-response framing. `dispatch` does in that single request what `resolve` does today (verify the target app, classify the action, check the stored grant, open the dialog when there is none), and only when all pass sends the call on the private driver channel. The channel is the worker's existing `Channel` in the host's slot map, selected by `worker_id`, which the daemon sets to the caller session; nothing in the daemon sends `start` today, so `dispatch` starts the slot itself when the worker has none, with the same code `start` runs (signature check, private home under `work_dir`, record). The daemon sends `work_dir` as the caller session's working directory. A slot ends through the existing `stop` (`stop-operation.ts`) or when the host exits. The reply carries the resolved app, class, decision, reason and whether input was sent. The host writes one log line per `dispatch`.

   As a discovery exception, `list_windows` without an app or pid lists windows across apps, including titles, without an app grant. It still requires an approved desktop-control worker. A targeted listing requires the app grant.
4. **The host answers only the live daemon process.** On each control connection the host reads the peer PID (tokio `peer_cred`, `LOCAL_PEEREPID` on macOS) and accepts only:
   - the sidecar it spawned, while it still holds that child unreaped (a PID cannot be reused before it is reaped); or
   - for an attached daemon, the `pid` in `runtime.json`, read again on every connection, and only when that process started at or before the file's `startedAt` and at most 60 seconds earlier. A recycled PID starts later and is refused; a restarted daemon writes a new file.

   Every other process gets `not_daemon`. No key, prompt or signing step.
5. **The owner approves each app once,** through the dialog and grant store (`desktop_grants.rs`).

## Cut

- Keychain key, user-presence prompt, nonce handshake and revocation rules: replaced by the peer-PID check.
- The signed-sidecar prerequisite and "off for attached daemons".
- Per-call tokens: only the daemon connects, and the daemon is already trusted.
- The two-phase audit and the withheld reply.
- Any change to the `desktop-mcp` proxy. It stays as is until Codex and Claude Code workers are in scope.

## Limits

- A process running as the daemon, or one that rewrites `runtime.json` before the host attaches, can act as the daemon. A worker with its sandbox off runs as the user and can already do that. The worker sandbox closes it; this design does not.
- A grant covers all action classes for one verified app, across tasks.

## Where it lives

- The mechanism is core: `packages/daemon/src/lib/desktop` (operation, pipeline, pure decision) and the desktop app (peer check, `dispatch`). A security boundary cannot sit in a pack, because packs can be turned off.
- A `computer-use` pack carries only Neo's guidance (see below). Sign-in, codes, forms and payment preferences stay in the delegation pack.

## Change

Two PRs:

1. Host: the peer-PID check on the control socket, and `dispatch` (start the slot if needed, resolve, grant check and send, in one request). It can be tested alone with a fixture driver and a fake peer.
2. Daemon: `desktop.call` with its in-process admission, one pipeline with `decideDesktopCall`, and the audit row.

## Neo guidance, the switch and readiness

### Problem

- Neo told a human to turn on desktop control in a settings page. No such switch exists.
  - Neo had called `desktop.call` itself, and only workers can call it.
  - `neo.todo.add` refuses a desktopControl todo with "turn it on from the todo on the Neo page".
- Workers on v0.60.2 got `target_unverified` because nothing told them every call needs `pid`. #11165 fixes this on dev.
- The global preference `core.desktopControl` already exists, with two values: "allow for tasks that need it" and "manual approval per task". It is asked once on a card and never shown again.
- Neo can use the computer three ways and has no rule for choosing:
  - native desktop control through a local worker;
  - a Codex or Claude Desktop worker with its own computer use;
  - the life-admin pack's Chrome DevTools connection, which reaches page content only.

### Design

1. **The `computer-use` pack holds the Neo guidance.**
   - Core keeps the operations, the opt-in rule, the preference and the admission gate.
   - The pack's `instructions()` read cached facts each turn (see Readiness): native ready, fallback eligible, and the preference.
   - When neither route is usable, `instructions()` returns only the handoff instruction, never null. `neo.pack.read` therefore still serves it.
   - The guidance:
     - Only a worker can call `desktop.call`.
     - Preference "allow": add the todo on a local worker with `named.desktopControl: true`.
     - Otherwise (manual or unset): add the todo with desktopControl omitted. The admission gate refuses true in that case. Then send the existing `desktop_control` card with that todoId and the app, and the human taps Allow. The app-wide grant dialog from #11165 still asks about each app.
     - Use native desktop control for every computer step, browser steps included. Try a fallback worker's own computer use only when native is not ready.
     - Handoff: ask the human with the step that fixes it (open HyperNeo Desktop and grant its permissions), or ask them to do the step themselves. This happens when neither route is usable, when a fallback start fails, or when the fallback worker reports it has no computer use.
2. **One switch on the Desktop control panel** (slice 2).
   - The panel shows whenever the desktop app answers, with zero workers too.
   - The switch reads and writes `core.desktopControl`:
     - on = allow for tasks that need it;
     - off = manual approval per task.
   - Inside the desktop app, turning it on calls the existing `desktop_permission_status` command. If a permission is missing, it opens the existing permissions window, whose button calls `open_desktop_permission_settings`.
   - Outside the desktop app (browser or phone), the panel shows the cached permission status. It says to open HyperNeo Desktop on that Mac to grant what is missing.
3. **Refusals say what to do.**
   - A non-worker caller gets `desktop_worker_only` (#11286).
   - In slice 1, the `neo.todo.add` refusal names the todo's "Let it use this computer" menu item and the Allow card. Slice 2 adds the panel switch to that text and to the pack guidance.
4. **Life-admin uses desktop control, not Chrome DevTools.** #11146 does this, and lands only after slice 1 ships the handoff. Chrome DevTools reaches page content only, so it cannot click extension popups such as a password manager, or browser dialogs.

### Readiness

- **Native ready** = the desktop app answers `{"action":"app_status"}` on `desktop/control.sock` with both Accessibility and Screen Recording granted.
  - Use the existing newline-delimited JSON framing and peer authorization. Handle this read-only request before worker validation. It takes no worker ID and returns `{accessibility, screenRecording}` from `desktop_permission_status` in the usual response envelope.
  - The existing per-worker `status` request keeps its worker ID and `{state, pid}` response.
  - Socket reachability alone does not count.
- **Fallback eligible** = `work.adapters` lists a Codex Desktop or Claude Desktop adapter with health ok and the start capability.
  - Listed, health-only or degraded adapters do not count.
  - Eligible only means Neo may try. Health checks the client version and read-only discovery, not computer use. A failed start, or a worker that reports no computer use, goes to the handoff.
- The daemon refreshes both facts every 30 seconds and caches them in memory.
- `desktop.status` returns them as top-level `app: {reachable, accessibility, screenRecording}`, which the panel reads.
- The pack's synchronous `instructions()` read the cache.

### Not in scope

- No new preference, table or column. No change to the worker-side opt-in rule.

### PRs

1. The `computer-use` pack, the readiness cache and the `app_status` socket action. The refusal text names the todo menu and the Allow card. This absorbs #11286.
2. The panel switch, plus the permission flow. It adds the switch to the refusal text and the pack guidance.
3. #11146, gated on slice 1's handoff, pointing life-admin at the pack.
