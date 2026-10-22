# Worker temporary data

Status: Design proposal; human approval is required before implementation.

## 1. Core: session-owned temporary directories

Reuse the worker start/end paths and existing scheduler. Create one private temporary
folder per worker session under an application-owned folder and set its TMPDIR at
start, retaining it on resume. Remove it when the session ends; a scheduled sweep
removes abandoned folders older than a day, excluding live sessions. Constrain removal
to owned folders without following symlinks.

Verify with synthetic workers: separate inherited TMPDIRs, contained child writes,
end cleanup, restart recovery and an aged-orphan sweep that preserves active owners.

## 2. Coding pack: worktrees and build caches

Reuse PR ledger facts, worktree ownership and the existing scheduler. Remove a PR's
owned, clean, unused worktree when it merges or closes; reconcile missed transitions
after restart. Preserve dirty or shared worktrees and report why cleanup was skipped.
The coding pack trims build caches on a schedule with each toolchain's own clean
command when idle. Core has no knowledge of PRs or toolchains.

Verify using synthetic Git repositories, ledger facts and disposable cache roots:
terminal PRs release only their worktrees, open/live/dirty/shared worktrees survive,
repeated cleanup is harmless, and clean commands affect only the disposable caches.

## 3. Repositories

Reuse repository verify/test helpers, changing temporary output to use the inherited
$TMPDIR, never a hard-coded /tmp. Verify with synthetic inputs and a unique TMPDIR
that all temporary writes stay inside it.
