# SDK compaction continues the active turn

Use the shared isolated RPC-proof setup in SKILL.md. Run from a worktree:

```bash
bash .claude/skills/verify/sdk-auto-compaction.sh /tmp/hyperneo-sdk-compact-fresh
```

The helper runs a real daemon, real Agent SDK and an ephemeral loopback model.
It uses NODE_ENV=test, fresh HOME/data/DB/SDK config, synthetic provider registration
and no real keys. It owns its daemon, SDK children and model server and closes them
in finally. No live daemon, port 8399 or real database is used.

The fake model requests two real Read tool calls, reporting usage below and then
above a configured 60% context threshold. The second response is held past the
old daemon's usage-cache interval; four human inputs queue during that call.
The SDK must emit an automatic compact_boundary and finish the same task. Both
tool receipts must succeed, with no user-rejected tool result. Each human input
must retain one consumed durable row under its original id, and all four queued
markers must reach an actual model request without another send or restart.

Evidence: evidence/sdk-auto-compaction.json contains actual model requests, tool
receipts, SDK messages, built compaction settings and durable input rows. sdk.log
contains the run result; the JSON names the isolated run and SDK debug log.
This is an SDK/RPC user-surface proof, not a browser check or a real-provider test.
