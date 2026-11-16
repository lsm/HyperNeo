# Daily worker worktree cleanup

Use the isolated metadata-only setup in `../SKILL.md` with pinned Bun:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-cleanup-sweep.ts
```

The helper creates an isolated daemon and a synthetic Git repository with a local
bare origin. It stops background jobs, creates archived clean and unsaved sessions
and an active session, and calls `work.cleanup.sweep` over the real owner RPC.
The clean archived worktree and a done todo's worker disappear; the worker has a
permanent release fence and recorded release receipt. The unsaved, active and ownerless folders
stay. Human Codex and Claude folders are excluded from the receipt. The attention
entry records a cleanup digest, and a second sweep is safe.
It then runs the registered cleanup job once and observes one pending next-day run.

`work-cleanup-sweep.json` records both RPC receipts and the delivered digest.
Focused tests cover rebinding before the fresh plan and refusal by the release
fence. This proof does not exercise native Desktop clients or a day of elapsed time.
