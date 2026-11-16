# Owned clones and daemon archives clean up safely

Use the shared metadata-only setup from SKILL.md with the owned-daemon helper:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-cleanup-owned-folders.ts
```

The helper builds a synthetic source checkout with a local bare origin. It runs
the coding pack's real execution preparation twice into the data dir's
`claude-worktrees` root, the root the Claude Desktop archive passes. One prepared
clone pushes its worker branch; the other keeps a commit on a local branch while
HEAD sits on the published target. Both go through `cleanupOwnedWorktree`.

It then boots an isolated daemon with its job processor running, places three
HyperNeo session worktrees through the daemon's own worktree manager, and seeds a
done todo for each. One worktree is clean, one has an uncommitted file, and one is
clean with a running process inside. It moves the pending driver refresh job to now
and waits for the archives to finish; then it stops the process and lets later
refreshes run.

End state in `work-cleanup-owned-folders.json`: the published clone is removed and
the unpublished one kept with its local commit. The clean worker is `archived`,
its worktree folder and `session/<id>` branch are gone; the worker with unsaved
work stays `active` with its folder. The busy worker is `archived` with its
folder kept and no `core/released` fact; after its process exits, a later refresh
removes the folder and records the release. Before the kept worktree was reported
back, the busy worker was recorded as released while its folder stayed. Before the
step-4 change the published clone
is kept as "not a linked worker worktree", so the helper fails.

The Desktop adapter's own archive call and a daemon archive that races a new edit
are covered by the focused unit tests, not this helper. No model, provider,
Desktop app or real data is used.
