# Legacy session tool saves (Tools 6d.2b)

Use the shared in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/legacy-session-tools.ts`. No HTTP model mock,
provider registration or GUI is required. The helper owns two daemon boots,
WebSockets and a synthetic in-memory MCP server. All data is synthetic.

Run the committed failing reproduction before the fix: tools.save succeeds but
cold session.get returns the old canonical choice. With the fix:

- Save instruction/wrapper choices through tools.save, then through session.update
  together with an ordinary field and an unchanged canonical-selection echo.
  Read canonical choices, legacy disabled IDs, frozen aliases and native Read
  settings back through session.get.
- Poison caller-thread preference capture during a save. It still succeeds:
  capture runs in the gateway's read-only worker transaction, with complete source
  guards passed to the existing atomic commit. Record workerCaptureVerified=true.
- Keep both a SessionManager actor and a second real AgentSession owned through
  the TaskAgentManager cache lookup. Both configs change after accepted writes,
  with neither query started nor actor evicted; the duplicate actor keeps its
  runtime-only MCP definition.
- Inject a synthetic SQL failure. The RPC reports failure, persisted preferences
  and both caches stay unchanged.
- Set and clear the session MCP override through its existing RPC. Clearing
  inherits canonical global defaults, retaining the frozen alias. Inspect the
  matching legacy override absence and both actor configs.
- Disable then delete synthetic instruction skills. tools.save and session.update
  must both remove the stale disabled ID and still save valid settings. A removed
  MCP server with a surviving wrapper must behave the same way. Missing choices
  stay unbound, frozen aliases survive, and neither cache retains the stale list.
  Record deletedDefinitionSaves=true. New unknown disabled IDs still refuse.
- Hold the first real CAS before worker submission, issue a second override for
  that session concurrently, and complete an independent-session override before
  releasing it. Both sibling set requests must fulfill, then both sibling clear
  requests must fulfill. Read both canonical choices, legacy rows and cached
  configs back. This reproduces ToolsModal's parallel save without sleeps. Record
  concurrentSessionOverrides=true and independentSessionNotBlocked=true. The
  existing SQL-failure step followed by a successful save also proves a rejected
  write does not poison the per-session queue.
- Restart only the owned daemon and read the same preferences through session.get.
  Inventory remains not_running; the synthetic MCP server lists navigate.

Pass: evidence/legacy-session-tools.json has pass=true, all save/cache/worker/
rollback/clear/restart checks true, legacyRpcWired=true, and sdkConsumerWired,
sdkApplyVerified and queryStarted false. This is RPC compatibility wiring, not
SDK attachment or a Use here UI proof. All resources close in finally.

Run the session-tool-preference-ownership repository tests too: an ordinary full
config write must keep newer owned preferences while changing ordinary fields;
absence and present-null ownership survive; pre-canonical legacy setup still
works. Fixtures that intentionally seed owned preferences use synthetic SQL.
Rerun the session-tool-writer foundation journey for source-guard races, inherited
clears and rollback. Its adapter now uses the worker capture facade; its direct
coordinator invocation remains separate from this RPC-wiring proof.
