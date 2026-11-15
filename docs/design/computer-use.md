# Computer use: HyperNeo sessions first (minimal)

Replaces the four-layer design in lsm/HyperNeo#10632. Scope: HyperNeo's own sessions only. Codex and Claude Code workers come later.

## Problem

A worker's desktop tool call never reaches a driver. The `desktop-mcp` proxy plans the call and then `dispatch` throws `driver_unavailable` (`packages/cli/src/desktop-mcp.ts`). The host app's control socket has `start`, `stop`, `status` and `resolve`, but no action that sends input (`desktop_drivers.rs`).

#10632 adds a keychain port key, a signed sidecar, per-call tokens and a two-phase audit, and it turns the feature off for any daemon the app did not spawn. A daemon run as a launchd service, a common setup, therefore never gets it.

## Why HyperNeo sessions make this small

A HyperNeo session already calls daemon operations in process: every session gets the `hyperneo-operations` MCP server unless `operationTools` is off (`query-options-builder.ts`). The daemon resolves the caller itself, so a session cannot claim to be another one. No proxy process and no new channel are needed.

## Design

1. **One daemon operation, `desktop.call {tool, args}`.** A HyperNeo session calls it through its existing `invoke` tool. The caller session comes from the operation's caller identity, never from the input.
2. **One superpipe pipeline in the operation:**
   - read facts: the caller's todo binding (`readDesktopTodos` / `desktopOptIn`: doing, approved, desktop control on), the host's `resolve` answer (app, action class), and whether the tool is in `tool-catalog.json`;
   - `decideDesktopCall(facts)`: a pure function that returns `allow`, or one existing reason (`tool_not_allowed`, `target_unverified`, `target_mismatch`, `app_action_not_authorized`, ...);
   - edge: on `allow`, call the host's new `dispatch`; otherwise return the refusal;
   - edge: write one audit row (todo, session, tool, app, class, decision, reason, dispatched, time).
3. **The host answers only the daemon process.** On each control connection the host reads the peer PID (tokio `peer_cred`, `LOCAL_PEEREPID` on macOS) and accepts only the daemon's PID. That is either the sidecar it spawned, or the `pid` in `runtime.json` it already reads to attach. Every other process gets `not_daemon`. No key, no prompt, no signing step, and it works with a launchd daemon.
4. **The host's `dispatch` re-checks.** It sends input only for a target it resolved in that same connection, and only when that app and class have a stored grant. It writes one log line per dispatch.
5. **The owner approves each app once,** through the existing dialog and grant store (`desktop_grants.rs`). Unchanged.

## Cut

- Keychain key, user-presence prompt, nonce handshake and revocation rules: replaced by the peer-PID check.
- The signed-sidecar prerequisite and "off for attached daemons".
- Per-call tokens: only the daemon connects, and the daemon is already trusted.
- The two-phase audit and the withheld reply.
- Any change to the `desktop-mcp` proxy. It stays as is until Codex and Claude Code workers are in scope.

## Limits

- A process running as the daemon, or one that rewrites `runtime.json` before the host attaches, can act as the daemon. A worker with its sandbox off runs as the user and can already do that. The worker sandbox closes it; this design does not.
- A grant is per app and class, not per task, as today.

## Where it lives

- The mechanism is core: `packages/daemon/src/lib/desktop` (operation, pipeline, pure decision) and the desktop app (peer check, `dispatch`). A security boundary cannot sit in a pack, because packs can be turned off.
- A `computer-use` pack is optional and later. It would only carry Neo's guidance: when to turn desktop control on for a todo, and which apps suit it. Sign-in, codes, forms and payment preferences stay in the delegation pack.

## Change

Two PRs:

1. Host: the peer-PID check on the control socket, and `dispatch`.
2. Daemon: `desktop.call` as one pipeline with `decideDesktopCall`, plus the audit row.
