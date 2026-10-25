# Imported tool defaults (Tools 6d.3d)

Use shared in-process setup in SKILL.md with
`PROOF=.claude/skills/verify/mcp-import-defaults.ts`. No fixed port, provider
registration or GUI is required. This helper owns one fresh synthetic daemon
database, two boots and sockets. Every MCP source is inside its run directory;
no server command executes and no user settings or credentials are read.

The initial reproduction must fail at real mcp.imports.refresh RPC readback:
imported rows exist but their canonical global/Space choices are absent.

After wiring require evidence/mcp-import-defaults.json pass=true and these flags:
disabledDefaults, addUpdateRemoveAndManualIntent, malformedPreserved,
rollbackWithoutNotice, rowFailureRollsBackBatch, missingSourcePruned,
orphanPruned, retiredOverrideOff, frozenSessionPreserved and restartRetainedDefaults.

- Import two entries through the real RPC. They remain disabled in both catalog
  and global/Space defaults. Manually enable one through the registry RPC, then
  update its metadata while adding and removing other entries: intent survives.
- A malformed source preserves its rows and defaults with a contextual note.
- A late Space default failure rolls back the entire import batch. A later row
  insertion failure also rolls back earlier additions. Neither publishes success.
- Missing sources and unregistered orphan paths prune their imported rows and
  retire corresponding canonical choices, including a prior explicit Space on.
  Existing sessions remain frozen.
- Cold session.get retains choices and the native Read preset; inventory remains
  not_running. Restart only the owned daemon and read the same persisted state.

Run the existing importer parity suite, new import RPC tests and the tool default
worker/MCP/skill preference suites. Direct-file refresh, namespace/legacy identity,
malformed retention and rollback must all survive the asynchronous worker boundary.
importDefaultCallerWired=true; sdkConsumerWired, sdkApplyVerified and queryStarted
remain false. No SDK attachment or UI activation is claimed.

Check `df -h /System/Volumes/Data` before heavy runs; stop below 25 GiB free and
tell Neo. Save evidence and remove only this run's temporary daemon data after
all owned resources close. Reuse installed dependencies; do not run installs.
