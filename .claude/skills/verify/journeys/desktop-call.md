# In-process desktop actions

Run this journey on a build host with the pinned Bun from SKILL.md. It starts an
isolated daemon on a random port with its own HOME and database, then calls the
real session's hyperneo-operations MCP server against a fake desktop host. The
session keeps the daemon's own caller role, as a todo worker Neo starts does. It
uses no model provider and sends no real GUI input. Worktrees are disabled in
the daemon config, and the job processor is stopped before fixture seeding.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-call.ts
```

Pass prints `desktop.call journey PASS host_requests=11 no_scope_refused=1 sibling_isolated=1 sibling_own_scope=1 host_busy=1 host_timeout=1 host_locked=1 resumed=1 initial_audit_rows=2
blocked_allowed=1 pending_allowed=1 current_preferred=1 ambiguous_refused=1 blocked_with_queued_allowed=1 finished_refused=1 driver_error_body=1 refused_paths=5 described_tools=12`: operations.describe lists every catalog tool.
The saturated host, expired request and locked screen reach the worker as
`desktop_busy`, `desktop_timeout` and `screen_locked` without input; the next call after
unlock dispatches.
Approved unfinished todos remain enabled after a worker blocks or returns to todo;
finished todos return `todo_not_active` without dispatching.
An active doing todo takes precedence over a blocked todo, and multiple opted-in
unfinished todos with none doing return `todo_ambiguous` without dispatching.
A queued todo without approved apps does not prevent dispatch for a blocked approved todo.
A todo without approved apps is refused before dispatch. Each dispatch carries only its own todo's approved bundle ids. A sibling todo on the same ask without its own apps gets `desktop_not_enabled`; once it has its own app, its dispatch carries only that app.
The press_key description gives shifted-symbol guidance and names driver_error for unknown keys.
A driver result with isError must come back as an MCP tool error (`isError: true`)
with `ok: false, reason: driver_error`
with the driver's text and image as MCP content blocks after the JSON reply. Its
audit row records `driver_error` and none of the driver's content. The JSON evidence is in `evidence/desktop-call.json`. RPC,
session door, caller impersonation, unlisted tools and an unapproved todo must
produce no host requests. The accepted request must use the caller session and
its daemon-owned workspace, and persist the host outcome without arguments in
mcp_audit_log. The script closes the fake host and daemon in its finally block.

The same runner drives the native worker's `work.stop` through the real WebSocket
operation. The MCP fixture supplies a synthetic turn. The stop acknowledgment
must wait for the host acknowledgment for that turn, its next Desktop call must
return `turn_stopped` without reaching the host, and a later turn in the same
session must dispatch. Pass prints `work.stop journey PASS` and writes
`evidence/desktop-turn-stop.json`.

Run the desktop-call operation contracts with Node 24 Vitest for the inactive,
ambiguous and remote binding cases, host refusals, sent errors, worktree path and
reply correlation. The real desktop host, Cua driver and owner dialogs remain
covered by the desktop-driver-private-channel and desktop-grant-approval
journeys.

Validate the discovery classification and generated API catalog with
`bun scripts/api-surface.ts --check` after changing this operation. The catalog
collector also launches its own isolated daemon and must include desktop.call.
