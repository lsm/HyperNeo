# Observed tool inventory foundation (approved Tools slice 1)

This Build slice has no active daemon capture or panel caller. It defines the
projection/lifetime contract; the old panel still shows configured state. Do not
claim a repaired panel, current-query capture or browser execution from this proof.
Those user-surface checks belong to the next wiring and rendering slices.

Use the shared isolated environment setup in SKILL.md with
`PROOF=.claude/skills/verify/observed-tool-inventory.ts`. No daemon, DB, provider,
model, HTTP mock or GUI is used by this foundation helper, and no port preflight
is needed. It connects a real synthetic MCP server/client through the SDK's
in-memory transport and lists its one synthetic tool. A scripted SDK init and
status observation feed the actual production projection with those tool names.

Pass: awaiting-init is empty; init observes tools/instructions without claiming
a per-server tool count; status supplies the exact tool name; late init/status
and stop from the old attempt cannot change the replacement; invalidating the
owner immediately removes attachment; ACP stays unverified. Plugin paths must
not appear in the projection. The helper asserts these facts and writes
`evidence/inventory.json`, including explicit false capture/panel verification
flags. It closes only its owned MCP transports in finally.

The focused suite additionally checks all status categories, zero versus unknown
tools, raw-error/config omission and mutation isolation. Run it with daemon
Vitest `tests/unit/1-core/agent/observed-tool-inventory.test.ts`. On tests-first
commit 2672ad9bd8 seven contract tests must fail. A missing-module error is not
the recorded reproduction. No actual attachment/permission to execute a browser
tool has been verified at this stage.
