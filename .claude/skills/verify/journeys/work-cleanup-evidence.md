# Work cleanup ages evidence and tells unsaved work once

Step 5c of the work cleanup. The daily sweep now also lists `work/evidence`:
todo evidence goes 7 days after its todo finished unless an open card or a live
todo still cites its path; worker `hn-*` evidence stays while its worktree exists
and goes 7 days after `work_cleanup_gone.gone_at`. A finished worker folder kept
for unsaved work reaches Neo in the cleanup digest once, after 3 days.

Use the isolated metadata-only setup in `../SKILL.md` with pinned Bun:

```bash
bash .claude/skills/verify/proof-run.sh /absolute/fresh/evidence-directory \
  .claude/skills/verify/work-cleanup-evidence.ts
```

The helper starts an isolated daemon, seeds done todos finished 8 and 2 days ago
(one of the old ones cited by an open card), two archived sessions whose worktrees
are gone (one with an 8-day-old gone row, one with none) and an archived session
whose real worktree holds an uncommitted draft. It calls `work.cleanup.sweep` over
the owner RPC three times.

The first sweep removes only the old todo's evidence and the old worker's
evidence, keeps the fresh, cited and newly gone evidence, and records the newly
gone worker's `gone_at`. The helper then moves the unsaved folder's first-seen
time back 4 days; the second sweep's digest names that folder, and the third
sweep does not repeat it. The unsaved worktree is never removed.

`work-cleanup-evidence.json` records the three RPC receipts and the delivered
digests. This proof does not wait real days; it seeds past timestamps.
The focused contract runs under Bun and Vitest from `packages/daemon`:

```bash
bun test tests/unit/1-core/work-cleanup/evidence.test.ts
node node_modules/vitest/vitest.mjs run tests/unit/1-core/work-cleanup/evidence.test.ts
```
