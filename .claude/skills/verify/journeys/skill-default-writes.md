# Skill default writers (Tools 6d.3c)

Use shared in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/skill-default-writes.ts`. No fixed HTTP port,
provider registration or GUI is required. The helper owns a fresh file-backed
daemon, two boots and sockets. Its one synthetic GitHub download is intercepted
in process; it does not fetch skill files from the network.

Before wiring, skill.create succeeds but its canonical default is absent. Preserve
that failing reproduction. With wiring, require evidence/skill-default-writes.json
pass=true, skillCrudAndIntent, rollbackBeforeEnqueueOrNotice,
syntheticInstallAndIdempotence, rejectedInstallNotPublished, concurrentWrapperBinding,
skillLiveQueryReadback, validationThroughLiveQuery, wrapperRebindAndDelete,
sharedWrapperDefault, frozenSessionPreserved and restartRetainedDefaults:

- Real skill create/update/enable/delete RPCs change catalog and global/Space
  defaults together. Inspect the synthetic DB alongside RPC replies.
- Inject a later Space write failure. The catalog row and global defaults roll
  back, with no validation job or skills.changed success notice.
- A concurrent wrapper rebind then enable chooses the committed backing server,
  with no default accidentally enabled for the old server. Read the wrapper
  through the same skills.list LiveQuery snapshot/delta as the web; wait for
  the real validation job to publish valid status.
- Rebind an enabled wrapper without passing enabled: clear the old server
  default and enable the committed new binding. Deletion clears the old binding
  when no enabled sibling remains. A disabled new sibling and disabling or
  deleting one of several siblings must not switch off the shared server while
  another remains enabled. Preserve explicit Space vetoes and frozen sessions.
  A refused rebind rolls back both bindings and publishes no success notice.
- Refuse an install at the same transactional boundary: no catalog/default row,
  plugin wrapper or success notice is published. Downloaded fixture files remain
  preparatory input and do not make the skill available.
- Install a synthetic SKILL.md, read the saved file, repeat the RPC and require
  the same ID without a second fetch. Invalid config still fails admission.
- Cold session.get preserves its frozen choices and native Read preset. The
  inventory remains not_running. Restart only the owned daemon and confirm the
  same defaults and frozen session.

Run skills-manager, skill handlers/validation, skill-default-writes, MCP defaults
and tool-default-transition unit suites. Cover wrapper-to-server intent, config
and pending validation rollback, validation commit failures and built-in deletion
admission. SDK/UI consumers and import reconciliation remain later slices;
sdkConsumerWired, sdkApplyVerified and queryStarted stay false. No attachment or
Use here UI proof is claimed. All owned resources close in finally.
