# Daily worker worktree cleanup

Step 5b releases worker worktrees without an age delay. Worker and todo evidence
live separately under `work/evidence` and remain untouched; their age/reference
cleanup is the separate step 5c that shares `planWorkRelease`'s evidence arm.

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
Fresh worker and todo evidence files keep their exact contents through both RPC
calls and the daily job, even though the finished worktree is removed immediately.

`work-cleanup-sweep.json` records both RPC receipts and the delivered digest.
Removed entries retain their owner reason. A deliberately invalid listing root
appears under `kept.error` while the remaining removals and daily job complete.
Focused tests cover owner selection, scoped refreshes, bounded status concurrency,
rebinding, the release fence and archive refusals preserved in the digest.
The runtime fixture uses the same root helpers as the adapters, a custom database
directory and a synthetic startup home that differs from CODEX_HOME. It matches
owned folders under all six root kinds. Session paths come directly from the DB;
confirmed removal receipts exclude released refs. Git tracing confirms that live
owners receive no Git probes; the first pass inspects at most four folders at a time.
This proof does not exercise native Desktop clients or a day of elapsed time.

Run the focused contracts under Node 24 and Vitest, matching CI, with pinned Bun
on PATH for the isolated fixture children. A Bun-only parent run does not verify
the Node/Vitest wrapper. From `packages/daemon`:

```bash
node node_modules/vitest/vitest.mjs run tests/unit/1-core/work-cleanup
```
