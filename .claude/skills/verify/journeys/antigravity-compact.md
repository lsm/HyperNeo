# Compact an idle Antigravity CLI worker

Run the isolated daemon with pinned Bun:

```sh
bash .claude/skills/verify/proof-run.sh /absolute/compact-evidence \
  .claude/skills/verify/antigravity-find.ts compact
bash .claude/skills/verify/proof-run.sh /absolute/unconfirmed-evidence \
  .claude/skills/verify/antigravity-find.ts compact-unconfirmed
```

Finish a worker's todo, queue the next todo of the same ask on it and run Neo's
scheduled refresh. Verify that the worker compacts its recorded conversation
once before that todo is sent, and that follow-up input is refused while
compaction is active. The todo is still sent when the CLI reports only a foreign
checkpoint and the compaction is unconfirmed.

For an attended check with the signed-in CLI, start a disposable conversation,
compact it after the first response, and verify that a follow-up in the same
conversation still recalls a marker from the initial turn.
