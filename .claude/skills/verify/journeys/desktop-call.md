# In-process desktop actions

Run this journey on a build host with the pinned Bun from SKILL.md. It starts an
isolated daemon on a random port with its own HOME and database, then calls the
real session's hyperneo-operations MCP server against a fake desktop host. The
session keeps the daemon's own caller role, as a todo worker Neo starts does. It
uses no model provider and sends no real GUI input. Worktrees are disabled in
the daemon config, and the job processor is stopped before fixture seeding.

```bash
RUN=$(mktemp -d /tmp/hyperneo-desktop-call.XXXXXX)
mkdir -p "$RUN/home"
env -i HOME="$RUN/home" HYPERNEO_DATA_DIR="$RUN/data" NODE_ENV=test PATH="$PATH" \
  bun .claude/skills/verify/desktop-call.ts "$RUN"
```

Pass prints `desktop.call journey PASS host_requests=9 host_busy=1 host_timeout=1 host_locked=1 resumed=1 initial_audit_rows=2
blocked_allowed=1 pending_allowed=1 current_preferred=1 ambiguous_refused=1 blocked_with_queued_refused=1 finished_refused=1 driver_error_body=1 refused_paths=5 described_tools=12`: operations.describe lists every catalog tool.
The saturated host and expired request reach the worker as `desktop_busy` and
`desktop_timeout` without input. A locked host returns `screen_locked` without input, audits the reason, and accepts a fresh call after the lock clears.
Approved unfinished todos remain enabled after a worker blocks or returns to todo;
finished todos return `todo_not_active` without dispatching.
An active doing todo takes precedence over a blocked todo, and multiple opted-in
unfinished todos with none doing return `todo_ambiguous` without dispatching.
A blocked todo and a queued todo with desktop control off are refused without dispatch when neither is doing.
The press_key description gives shifted-symbol guidance and names driver_error for unknown keys.
A driver result with isError must come back as an MCP tool error (`isError: true`)
with `ok: false, reason: driver_error`
with the driver's text and image as MCP content blocks after the JSON reply. Its
audit row records `driver_error` and none of the driver's content. The JSON evidence is in `evidence/desktop-call.json`. RPC,
session door, caller impersonation, unlisted tools and an unapproved todo must
produce no host requests. The accepted request must use the caller session and
its daemon-owned workspace, and persist the host outcome without arguments in
mcp_audit_log. The script closes the fake host and daemon in its finally block.

Run the desktop-call operation contracts with Node 24 Vitest for the inactive,
ambiguous and remote binding cases, host refusals, sent errors, worktree path and
reply correlation. The real desktop host, Cua driver and owner dialogs remain
covered by the desktop-driver-private-channel and desktop-grant-approval
journeys.

Validate the discovery classification and generated API catalog with
`bun scripts/api-surface.ts --check` after changing this operation. The catalog
collector also launches its own isolated daemon and must include desktop.call.
