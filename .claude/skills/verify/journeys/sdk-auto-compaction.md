# SDK compaction continues the active turn

Use the shared isolated RPC-proof setup in SKILL.md. Run from a worktree:

```bash
bash .claude/skills/verify/sdk-auto-compaction.sh /tmp/hyperneo-sdk-compact-fresh
```

The helper runs a real daemon, real Agent SDK and an ephemeral loopback model,
for an ordinary session, Neo, the configured/native Opus 1M cases and a 1M Neo at 45%. Only the
model catalog is seeded with synthetic 200K/1M capability metadata; SDK context
usage and compaction are real.
It uses NODE_ENV=test, fresh HOME/data/DB/SDK config, synthetic provider registration
and no real keys. It owns its daemon, SDK children and model server and closes them
in finally. No live daemon, port 8399 or real database is used.

The fake model requests two real Read tool calls, reporting usage below and then
above a configured 60% context threshold (90% for Opus). The second response is held past the
old daemon's usage-cache interval; four human inputs queue during that call.
The SDK must emit an automatic compact_boundary and finish the same task. Both
tool receipts must succeed, with no user-rejected tool result. Each human input
must retain one consumed durable row under its original id, and all four queued
markers must reach an actual model request without another send or restart.

The 45% case first reports 300K, between 45% of the window applied twice (about 208K)
and the 450K threshold the daemon shows, then 460K. The SDK debug log must name only
threshold 450000, so the SDK compacts at the threshold the daemon shows.

Evidence: evidence/sdk-auto-compaction-{ordinary,neo,opus1m,opus-native,neo45}.json contains actual model requests, tool
receipts, SDK messages, built compaction settings and durable input rows;
evidence/sdk-debug-<case>.log holds each SDK debug log. sdk.log
contains the run result; the JSON names the isolated run and SDK debug log.
This is an SDK/RPC user-surface proof, not a browser check or a real-provider test.

Fresh dev uses `@anthropic-ai/claude-agent-sdk` 0.3.316 / Claude Code 2.1.316.
Official references: [automatic compaction](https://code.claude.com/docs/en/agent-sdk/agent-loop#automatic-compaction),
[environment variables](https://code.claude.com/docs/en/env-vars),
[window configuration](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window).
The installed SDK's `sdk.d.ts` documents `precomputeCompactionEnabled`.
The proof records the existing 153K window and a real 120K auto-compact threshold
at 60%. The daemon sends that window or the SDK percentage, never both: the window
already carries the percentage, and the SDK would apply it again. The threshold
`getContextUsage` reports ignores the SDK percentage, so read the debug log's
threshold instead. The web docs do not explicitly promise
that compaction never rejects a tool; the observed successful receipts prove that
behavior for this pinned SDK and fixture.
