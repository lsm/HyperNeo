# A merged design keeps implementation work open

Use the shared isolated setup in SKILL.md with pinned Bun on PATH. Run on the
build/test host with a fresh absolute evidence directory.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/coding-design-followups.ts
```

The helper starts an isolated daemon on an ephemeral port, with synthetic session,
ask and merged-PR records. No provider, real credentials or GitHub requests are
used. It invokes the full coding sweep and reads its durable Neo mailbox message.
Recreating the pack and sweeping again must retain exactly one reminder naming
the ask and the design's Change section.

The real neo.ask.settle and neo.ask.read WebSocket operations must show the
merged-design ask staying open. A completed reminder turn must also fail to
settle it automatically through the native writer. An unstarted follow-up stops
the design reminder, while its unfinished work still prevents completion. Once
that implementation todo completes, the public ask card must show done.

Keep result.json and the wrapper's cleanup receipt. The helper closes its
transports, service and daemon in finally. The wrapper removes synthetic data.
This proves persisted reminder admission and visible ask state, without a model
executing the follow-up instructions. Focused tests cover removed follow-ups,
legacy summaries, ordinary documentation and paginated PR file coverage.
