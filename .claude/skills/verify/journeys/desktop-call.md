# In-process desktop actions

Run this journey on a build host with the pinned Bun from SKILL.md. It starts an
isolated daemon on a random port with its own HOME and database, then calls the
real session's desktop MCP server against a fake desktop host. The
session keeps the daemon's own caller role, as a todo worker Neo starts does. It
routes the template turn to a scripted loopback model and sends no real GUI input. Worktrees are disabled in
the daemon config, and the job processor is stopped before fixture seeding.

```bash
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh \
  /absolute/fresh/evidence-directory .claude/skills/verify/desktop-call.ts
```

The journey first proposes a Calculator todo through Neo's MCP operation and answers
its disclosure card through the human WebSocket door. The real work start must
create a Desktop template session. The actual SDK request to the loopback model
must expose the desktop action catalog and `report`, with a desktop-only system
prompt and brief. The saved SDK startup and HyperNeo composer must
show only the desktop MCP tools and no skills, slash commands or agents. Pass
prints `desktop worker inventory PASS`. The exact lists and Claude Code version
and the provider's prompt and brief are saved to
`evidence/desktop-worker-inventory.json`. The model calls `get_window_state` for Calculator
and tries `launch_app` for unapproved TextEdit. Both return `at` and `ms`. The
TextEdit call returns `app_not_in_todo_scope` without dispatching any input.
The model sends a result that reaches the assigning session. Reports with a
question or blocker stage the question on the bound task. The desktop session
must refuse operation discovery and a file read.
The fake host sends a synthetic token in both accessibility fields and a
screenshot. The desktop tool and underlying operation results must contain just a redaction marker
after the normal status. An app missing from the card and legacy cards with or without
recorded approval must refuse capture before dispatch. Pass prints `desktop worker template journey PASS` and saves
`desktop-worker-template.json`. The signed host and its dialogs remain a separate journey.

The runner also captures a non-desktop worker request. Compare
`ordinary-worker-brief.txt` from the baseline and changed runs with `cmp`.
The capture normalizes the generated IDs and fixture directory and omits the
SDK's environment disclosure. The remaining task brief must match byte for byte.

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
must name the in-flight call ID and wait for the host acknowledgment. A call
from the stopped turn returns `turn_stopped`, and a later turn in the same
session dispatches. The legacy-host fixture rejects the new stop command and
accepts the existing dispatch shape. Native Stop still succeeds in that case.
Pass prints `work.stop journey PASS` and writes
`evidence/desktop-turn-stop.json`.

Run the desktop-call operation contracts with Node 24 Vitest for the inactive,
ambiguous and remote binding cases, host refusals, sent errors, worktree path and
reply correlation. The real desktop host, Cua driver and owner dialogs remain
covered by the desktop-driver-private-channel and desktop-grant-approval
journeys.

Validate the discovery classification and generated API catalog with
`bun scripts/api-surface.ts --check` after changing this operation. The catalog
collector also launches its own isolated daemon and must include desktop.call.
