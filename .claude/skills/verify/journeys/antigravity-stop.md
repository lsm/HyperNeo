# Stop Antigravity CLI work

Use the isolated daemon and pinned Bun from the Verify skill:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/stop-evidence \
  .claude/skills/verify/antigravity-find.ts stop
bash .claude/skills/verify/proof-run.sh /absolute/stop-race-evidence \
  .claude/skills/verify/antigravity-find.ts stop-race
```

Start and resume an owned session. Two concurrent `work.stop` calls send one
notification to the active session and wait for its prompt result. A cancelled
result reports `stopped: true` and leaves no completed reply on that receipt.
An ordinary completion reports `stopped: false` and retains its reply. Idle
and foreign sessions receive no cancellation notification.

For an attended check, start a disposable turn with the signed-in CLI, stop
that turn, and observe `stopped: true` followed by a `stopped` status.
