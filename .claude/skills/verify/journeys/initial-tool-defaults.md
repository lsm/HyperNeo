# Initial session defaults (Tools 6d.4)

Use the shared in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/initial-tool-defaults.ts`. No fixed HTTP port,
provider registration, SDK query or GUI is required. One fresh synthetic DB,
two daemon boots and owned sockets are used. No external MCP command executes.

Preserve a failing real-RPC reproduction before the fix: session.create returns
a session with no canonical selection despite a saved on template.

Require evidence/initial-tool-defaults.json pass=true plus rpcAndHotCacheFrozen,
writerOffMain, mainThreadProbeNegativeControl, matchingScopeDefaults, sessionVetoesFrozen,
factoryWorkflowVetoesFrozen, workflowInputsCaptured, existingSelectionsPreserved,
unsupportedDefaultsRefused, coldReadback and restartPreserved:

- With old catalog flags off, seed explicit global on and differing Space
  templates. The normal session.create RPC and its hot cache freeze the matching
  template, including aliases and native Read preset. Session skill vetoes apply.
  Space-scoped sessions use AgentSession.fromInit, the permitted worker-factory
  path; the human session.create RPC intentionally refuses Space creation.
- Reject initial-selection SQL on the main connection. The real file-backed
  writer must still initialize and insert successfully through its owned worker.
  First call the preparation helper directly against the owned main connection
  and require the probe to reject it before SQL: a vacuous guard is not a pass.
- Use the real AgentSession.fromInit worker-factory door with captured workflow
  skill vetoes. Mutate the caller array immediately after submission; the
  captured original veto must survive the queued write. Read its frozen result in memory and through the same session.get
  RPC used by the UI. The factory starts no query and uses no provider key.
- Change defaults and create another session: existing selections retain their
  original choices. Reload an existing factory session with different incoming
  vetoes; never reapply initial policy. Cold RPC readback and an owned restart
  retain the same frozen selection and native preset.
- Unsupported defaults refuse creation with no inserted row. Unit tests also
  cover existing supplied selections, absent-template legacy fallback, queued
  caller mutation and SQL insertion failure without publishing a caller snapshot.

Run initial-tool-default-writes, session-tool-inputs, legacy-tool-preferences,
session lifecycle/manager, AgentSession and SessionRepository suites. Native/SDK
consumer wiring is covered by `canonical-sdk-tool-inputs.md`. This harness reports
initialCreationWired=true;
sdkConsumerWired, sdkApplyVerified and queryStarted remain false as harness scope
flags, not current global availability. This is persistence
and constructor/cache proof, not SDK attachment or a new UI control.

Check disk space before heavy runs; stop below 25 GiB and notify Neo. Reuse
installed dependencies without installation. Save evidence, then remove only
this run's temporary data after all owned resources close.
