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

Pass prints `desktop.call journey PASS host_requests=1 audit_rows=1
refused_paths=5 described_tools=12`: operations.describe lists every catalog tool. The JSON evidence is in `evidence/desktop-call.json`. RPC,
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
