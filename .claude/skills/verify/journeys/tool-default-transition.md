# Atomic default-transition worker (Tools 6d.3a)

Use shared in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/tool-default-transition.ts`. No fixed HTTP port,
provider registration or GUI is required. The helper owns a fresh file-backed
isolated daemon, two boots, sockets and an in-memory synthetic MCP server.

This is a Build slice. Invoke the registered worker operation directly, then read
its catalog effects through the real registry RPC and the web's skills.list
LiveQuery subscription. Canonical templates are inspected in the synthetic DB;
cold session.get proves the existing session stays frozen. Active setters and
SDK/UI consumers are not wired by this slice.

Pass requires:

- Seed a disabled wrapper/server, an instruction and frozen canonical defaults.
  Seed two Space templates and a veto in one Space. Invoke one catalog transition:
  the global and inheriting Space defaults turn on despite the legacy wrapper
  gate; the explicit Space veto and existing session choices stay unchanged.
- Create a Space after startup with no stored template, then rename a catalog
  entry with no choice edits. Its defaults remain absent and updatedAt stays
  unchanged; compare to its effective baseline rather than undefined storage.
  Record absentDefaultsRemainAbsent=true. Unit fixtures cover global absence too.
- Reject caller-thread SQL from the daemon transition module (exclude the helper's
  same-named file). Direct invocation against the synthetic main connection must
  fail before writes: mainThreadProbeNegativeControl=true. The file-backed gateway
  invocation must then commit through the existing writer worker. Unrelated
  asynchronous startup SQL must remain allowed.
- Clear the Space override through the worker. It inherits the canonical global
  default even though the old wrapper gate remains off.
- Include a missing skill update after a registry mutation. The worker refuses
  the batch and rolls back the earlier write without notifications. Record
  missingSkillBatchRefused=true. Unit fixtures cover all skill update methods;
  new inserts remain allowed, duplicate inserts roll back normally.
- Inject a synthetic failure on a later Space default update. The earlier catalog
  mutation and global default both roll back. A batch instruction enable then
  appears in the same LiveQuery snapshot consumed by the web's skill store.
- Restart only the owned daemon: canonical templates survive and session.get
  returns its original frozen choices. Inventory remains not_running and the
  synthetic MCP protocol fixture lists navigate.

Read evidence/tool-default-transition.json. Require pass=true and true
workerOffMain/globalAndSpaceDefaults/explicitSpaceVetoPreserved/
clearInheritedCanonicalDefault/rollback/frozenSessionPreserved/
skillLiveQueryReadback/restartRetainedDefaults flags. defaultCallerWired,
sdkConsumerWired, sdkApplyVerified and queryStarted remain false. No attachment
or Use here UI proof is claimed. All owned resources close in finally.

Run tool-default-transition.test.ts alongside tool-preference-commit,
legacy-tool-preferences, write-session-tool-preferences,
session-tool-selection-migration and change-session-tool-choice suites. These
cover invalid versions, missing targets, atomic batch refusal, Space scope,
no notification replay after rollback, frozen aliases and unchanged timestamps
when a catalog edit changes no canonical default. The worker reuses the existing
projection and atomic commit shells. Callers in later slices retain admission,
filesystem/network validation and post-commit scheduling responsibilities.
