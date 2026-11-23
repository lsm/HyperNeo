# Compact an idle Antigravity CLI worker

Run the isolated daemon with pinned Bun:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/compact-evidence \
  .claude/skills/verify/antigravity-find.ts compact
bash .claude/skills/verify/proof-run.sh /absolute/unconfirmed-evidence \
  .claude/skills/verify/antigravity-find.ts compact-unconfirmed
```

Finish a worker's todo and run Neo's scheduled refresh. Verify that the kept
worker compacts its recorded conversation once, and that follow-up input is
refused while compaction is active. The CLI must report a completed checkpoint
for that conversation before Neo records the compaction. A foreign checkpoint
with a successful process exit is recorded as an unconfirmed attempt.

For an attended check with the signed-in CLI, start a disposable conversation,
compact it after the first response, and verify that a follow-up in the same
conversation still recalls a marker from the initial turn.
