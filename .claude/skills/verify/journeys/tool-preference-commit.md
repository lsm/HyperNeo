# Atomic compatibility commit foundation (Tools 6d.1)

Use shared isolated in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/tool-preference-commit.ts`. No fixed port, HTTP model,
provider registration or GUI is required. The helper owns two ephemeral daemon
boots, a fresh synthetic DB, its sockets and an in-memory MCP protocol fixture.
No external MCP executable or SDK query runs.

This Build slice exposes storage primitives, not a new operation or active setter.
No consumer or UI changes before 6d.5. Existing legacy setters are intentionally
unchanged; a concurrent legacy-only RPC edit can still differ from frozen intent.
The new primitive must refuse that stale write, preserving both stored values.

Pass requires:

- Create a manual session and disabled synthetic catalog rows through RPC.
- Through the real DB worker, atomically write canonical choices, legacy tools and
  a session MCP override. Cold session.get and session.mcp.list must read them.
  The native Read preset remains unchanged.
- Inject a synthetic SQL failure after the session update, during the override
  write. The entire transaction rolls back. Then change the override via RPC:
  an old captured override must be refused without changing canonical intent.
- Commit a catalog/default update. Registry RPC readback reflects the edit while
  session.get still returns the frozen session choices. A failing default edit
  rolls back its catalog change too.
- Restart only the owned daemon. Both canonical settings and the final legacy
  override survive. Inventory stays not_running; the MCP fixture lists navigate.

`evidence/tool-preference-commit.json` must contain pass=true and true
workerCommitAndRpcReadback/partialWriteRolledBack/concurrentOverrideRefused/
defaultFailureRolledBack/restartRetainedCanonicalAndLegacy flags. Activation,
SDK-apply and query-start flags remain false. The helper closes its own resources.

The commit helpers are internal transaction shells. Capture every source row used
for a decision (including absent overrides) and the target before planning. Pass
those snapshots to commit; session CAS retains its full original/incarnation guards.
Legacy callbacks must perform synchronous SQL only; publish events or update caches
only after won. A false callback result rolls back, and infrastructure errors throw.
Malformed/non-object defaults are refused; target validation after the callback
prevents a successful SQL no-op from losing the canonical field.
Later wiring owns caller policy, version validation and cached-session/application
synchronization. Raw row snapshots are internal data, never RPC/operation results.

Run tool-preference-commit.test.ts, session-runtime-settings-write.test.ts,
change-session-tool-choice.test.ts, legacy-tool-preferences.test.ts and
session-runtime-settings.test.ts. They cover stale/missing rows, cross-session
writes, rollback, JSON-object storage, Space/global defaults and same-ID recreation.
No canonical attachment or working Use here control is claimed in this slice.
