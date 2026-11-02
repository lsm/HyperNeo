# Upgrade the installed Agent SDK without losing a session

Use SKILL.md's resource guard and synthetic HOME/data rules. Run the following
journeys sequentially, preserving their evidence before removing each run's
temporary data. Never use the owner's daemon or credentials for these proofs.

- Run the full daemon unit suite with SKILL.md's isolated-unit setup.
- Build the compiled server and follow `sdk-download-first-start.md`. Require the download
  version to match the exact dependency pin and the actual native initialization
  to match that CLI version. Receiving a reply alone cannot detect a stale
  compiled downloader fallback.
- Follow `sdk-auto-compaction.md`: actual sessions start, receive input, execute
  Read tools and continue through compaction without losing queued input.
- Follow `idle-session-restart.md`: ordinary and root Neo sessions receive new
  input after exactly one daemon restart, using the installed SDK.
- Follow `interrupt-preserves-queued-inputs.md`: interrupt an active native SDK
  request through the public RPC and require queued inputs in its next turn.
- Follow `sdk-permission-spawn.md`: observe native initialization and permission
  control under ordinary and worker-policy settings; builder regressions cover
  explicit plan mode.
- Follow `neo-human-direct-worker-turns.md`: a real worker reply reaches Neo,
  whose native SDK/MCP tool call must persist the follow-up todo.

The loopback model scripts exercise the real SDK/CLI transport, daemon RPCs and
persisted conversations. They do not prove real provider authentication or model
judgment. After the upgrade is merged and normally deployed, separately create
one owned laptop worker, require a successful tool result and reply, resume it,
then stop and remove its test data through supported operations. Check the
owner daemon's logs for SDK errors. Revert the upgrade if this live check fails.
