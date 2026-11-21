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
   - read facts: the caller's approved, unfinished todo bindings on open asks (`readDesktopTodos` / `desktopAllowed`). Prefer a doing todo; otherwise select the sole todo that has not turned desktop control off. The input schema comes from `tool-catalog.json`, so an unlisted tool or bad arguments fail validation and `operations.describe` lists every tool;
   - `decideDesktopCall(facts)`: a pure function that returns `send` or a refusal. It distinguishes a finished opted-in todo (`todo_not_active`) and multiple opted-in candidates with none doing (`todo_ambiguous`) from `desktop_not_enabled`. The host is not contacted on a refusal, so no owner dialog can open for a call the daemon would refuse;
   - edge: on `send`, one host `dispatch` request (below);
   - edge: write one audit row from the host's reply (todo, session, tool, app, class, decision, reason, dispatched, time).
3. **One host request, `dispatch {worker_id, work_dir, tool, args}`.** The control socket keeps its one-request, one-response framing. `dispatch` does in that single request what `resolve` does today (verify the target app, classify the action, check the stored grant, open the dialog when there is none), and only when all pass sends the call on the private driver channel. The channel is the worker's existing `Channel` in the host's slot map, selected by `worker_id`, which the daemon sets to the caller session; nothing in the daemon sends `start` today, so `dispatch` starts the slot itself when the worker has none, with the same code `start` runs (signature check, private home under `work_dir`, record). The daemon sends `work_dir` as the caller session's working directory. A slot ends through the existing `stop` (`stop-operation.ts`) or when the host exits. The reply carries the resolved app, class, decision, reason and whether input was sent. The host writes one log line per `dispatch`.

   As a discovery exception, `list_windows` without an app or pid lists windows without an app grant, keeping only windows of apps in the todo's approved scope. It still requires an approved desktop-control worker. A targeted listing requires the app grant.
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

## Two todos on one Mac

The host keeps an in-memory lease table, because it resolves each target and sends each action.

- A call that names a window leases that window (verified process instance plus window id) to its worker. A call with only a pid leases the whole app instance and conflicts with every window lease on it.
- Another worker waits for the lease until its call deadline, then gets `window_busy`. The target is resolved again before dispatch.
- A lease belongs to a todo. Each dispatch carries its todo and the todos that may still use the desktop, so a finished todo's lease lapses at the next conflict, and a reused worker drops its previous todo's leases.
- While input may be running, a lease never lapses: it settles after the call, and Stop or a failed shutdown keeps it until the driver is confirmed gone. A settled lease ends after 30 seconds without a call, or when the process or window is gone.
- A `foreground` call also takes one machine-wide lock, before the target is checked again. A second foreground call waits, then gets `foreground_busy`. If the driver cannot be confirmed stopped, the lock stays held until Stop confirms it. Background calls need only the window lease.
- Browser workers opening their own window comes later; until then, a busy window means waiting.

## Where it lives

- The mechanism is core: `packages/daemon/src/lib/desktop` (operation, pipeline, pure decision) and the desktop app (peer check, `dispatch`). A security boundary cannot sit in a pack, because packs can be turned off.
- A `computer-use` pack carries only Neo's guidance (see below). Sign-in, codes, forms and payment preferences stay in the delegation pack.

## Change

Two PRs:

1. Host: the peer-PID check on the control socket, and `dispatch` (start the slot if needed, resolve, grant check and send, in one request). It can be tested alone with a fixture driver and a fake peer.
2. Daemon: `desktop.call` with its in-process admission, one pipeline with `decideDesktopCall`, and the audit row.

## Neo guidance and the switch

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

Two facts stay apart: whether desktop control may be used, and whether Neo asks first. It may always be used once the human allows it. `core.desktopControl` only decides whether Neo asks.

1. **The `computer-use` pack holds the Neo guidance.** It is `alwaysEnabled`, as delegation is, and only text: core keeps the operations, the opt-in rule, the preference and the admission gate.
   - Only a worker can call `desktop.call`.
   - Preference true: add the todo on a local worker with `named.desktopControl: true`.
   - Otherwise: add the todo with desktopControl omitted, then send the `desktop_control` card with that todoId and the app.
   - Use native desktop control for every computer step, browsers included.
   - `desktop_app_not_connected`: ask the human to open HyperNeo Desktop. `desktop_permissions_required`: the app opened its permissions guide; wait.
2. **One card per todo, three answers**: "Yes, and don't ask again" allows this todo and sets the preference true; "Only this task" allows this todo; "No" leaves it off so Neo takes another route or hands the step to the human. The daemon applies the answer, the todo opt-in and the preference in one transaction, so every client and the API behave the same. The separate ask-once preference card goes away.
3. **One switch on the Desktop control panel.** It reads and writes `core.desktopControl`: on = don't ask, off = ask per todo.

### Not in scope

- No new preference, table or column. No change to the worker-side opt-in rule.

### PRs

1. The `computer-use` pack, and refusal text that says what to do.
2. The three-answer card and the panel switch.
3. Point the life-admin pack at this pack; #11146 already moved it off Chrome DevTools.
