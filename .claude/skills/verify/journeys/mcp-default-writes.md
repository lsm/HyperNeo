# MCP default writers (Tools 6d.3b)

Use shared in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/mcp-default-writes.ts`. No fixed HTTP port, provider
registration or GUI is required. The helper owns a fresh file-backed daemon, two
boots, sockets and an in-memory synthetic MCP server.

Run the failing reproduction before wiring: registry.setEnabled succeeds and
changes the legacy row, but the global canonical default stays off. With wiring:

- Through the real registry create/update/setEnabled/delete RPCs, inspect matching
  global and Space templates in the synthetic DB. A disabled legacy wrapper must
  not mask explicit catalog intent. Existing session choices stay frozen.
- Exercise mcp.enablement set/clear at Space scope and space.mcp set/clear.
  Preserve explicit Space vetoes and clear to canonical global defaults. Repeating
  clear with no legacy row remains accepted, with the original RPC response shape.
- Send generic Space-scope set and clear requests for a missing Space. Both
  errors identify it as `Space not found: <id>`; no override, defaults or success
  notification is written. Require contextualMissingSpace=true. Mapping uses the
  authoritative worker refusal rather than adding a caller-thread pre-read.
- Simulate a legacy import that enabled a server outside the transition while
  its key is absent from canonical global defaults. Clearing with no legacy
  override or local choice is a true no-op through both Space APIs: preserve
  absent/empty templates, timestamps and notification silence. Require
  unchangedImportClearPreserved=true. An actual local reset still treats an absent
  canonical global key as off; never infer an enable from legacy flags. Require
  canonicalMissingKeyRemainsOff=true. Import reconciliation remains owned by 3d.
- Save two registry toggles concurrently: both succeed without losing either
  canonical choice. Internal worker serialization owns the atomic transition.
- Fail a later Space write with a synthetic SQL trigger: earlier registry and
  global changes roll back; no mcp.registry.changed success event is published.
- Rename without a choice edit after creating a new Space: its absent template
  and timestamp stay unchanged. Reserved-name admission still refuses writes.
- Cold session.get must retain its original selection and native Read preset.
  Restart only the owned daemon and read the same templates and frozen session.
  Inventory remains not_running; the synthetic MCP protocol lists navigate.

Require evidence/mcp-default-writes.json pass=true and true registryCrudAndIntent,
bothSpaceApis, repeatedClear, parallelToggles, rollbackWithoutNotification,
absentTemplatePreserved, frozenSessionPreserved and restartRetainedDefaults.
mcpDefaultCallerWired=true; skillDefaultCallerWired, importDefaultCallerWired,
sdkConsumerWired, sdkApplyVerified and queryStarted remain false. No attachment
or Use here UI proof is claimed. All owned resources close in finally.

Rerun tool-default-transition.ts too. The worker now has a typed repository call
adapter; its shared pipeline and SQL-probe negative control stay the same. Its
changed receipt allows clears that reset canonical intent to publish after commit,
even when no legacy row existed. False from an idempotent override clear is not a
missing-target refusal; other missing mutation targets still refuse atomically.
Run MCP handler, default worker and existing tool preference suites. Unit fixtures
must include actual Space rows/schema behind mocked SpaceManager discovery.
