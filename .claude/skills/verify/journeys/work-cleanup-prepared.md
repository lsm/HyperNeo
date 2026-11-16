# Cleanup of a prepared HyperNeo worker clone

A prepared HyperNeo worker runs in its own clone under the project's worktree
root and has no recorded worktree. Use the isolated setup in `../SKILL.md` with
pinned Bun:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-cleanup-prepared.ts
```

The helper starts a real prepared HyperNeo worker over RPC with the coding pack,
binds it to a finished todo and calls `work.cleanup.sweep` over RPC. The clone is
removed with reason `todo done` through `neo.session.archive`, the release is
recorded on the todo, and the source checkout stays. The proof uses a synthetic
model endpoint; it does not run a model turn.
