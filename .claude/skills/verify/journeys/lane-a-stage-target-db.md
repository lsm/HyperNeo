# Coding target selection through the DB gateway

Use the shared isolated setup and resource guard in `../SKILL.md`.

```sh
bash .claude/skills/verify/proof-run.sh "$EVIDENCE" .claude/skills/verify/lane-a-stage-target-db.ts verify
```

The helper saves Write/Review/Verify settings through authenticated WebSocket RPC.
It calls the retained Verify selector through `CodingAssignmentsRepository` and
the daemon gateway, checking default-first ordering, preferred targets, fallback
explanations and persistence after restart. An unanswered repository saves nothing.

During selector calls, preference and alias SQL must stay off the main connection.
Each decision runs through the read-only gateway. A held synthetic writer lock
must allow the reader to return before release. Evidence records gateway commands,
argument and reply sizes, durations and observed selections. The helper cleans up
both isolated daemon instances. Actor dispatch remains covered by assignment
contracts in CI. This journey does not claim native session startup.

Historical before-mode evidence concerns the original DB gateway migration.
Current retirement verification uses verify mode against the checked-out tree.
