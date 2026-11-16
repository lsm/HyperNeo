# Work cleanup: HyperNeo removes what it created

Checked against dev fe93cdb6dc.

## Summary

HyperNeo creates a worktree, work folders and build output for every worker it starts. A user who runs hundreds of tasks a day fills a disk in days, and a full disk stops everything: the database refuses writes and a session can stall on a half-written transcript. The user must not clean this by hand.

This design makes cleanup a core subsystem with two layers:
- **Release at the end.** When the work a folder belongs to is over, the daemon removes that folder.
- **Daily backstop.** A sweep finds what the release missed and removes it only on evidence from the database that nothing can use it. A folder with no owner record is never removed.

A disk guard warns Neo before the disk is full and holds new worker starts below a floor.

## Why core, not a pack

Every folder here is created by core (work placement, sessions, the todo runner), and every fact that decides its end is core's: the todo's state, the worker binding (`neo_todo_sessions`), the session's archive state. A pack's own end facts (a merged PR) already reach core as the todo's `done`. The rules are the same for every pack. A pack would need core's private placement facts, so it stays in core (`lib/work-cleanup/`).

## What exists

- `workerWorkLocations(root)` (`lib/work-locations.ts`) derives, per worktree root, `work/builds`, `work/scratch` and `work/gh-config` folders keyed `hn-<hash(root)>`, and `work/evidence`. Todo evidence lives in `work/evidence/<todoId>`.
- `cleanupOwnedWorktree` (`lib/drivers/work-placement.ts`) removes a linked worktree only under a known root and only when it is clean, pushed and has no submodule risk; otherwise it keeps it with a reason. The Codex, Claude Desktop and Copilot adapters call it from their `archive`. `releaseWorkerSandbox` (`worker-sandbox.ts`) removes only `scratch`.
- `session-lifecycle.ts` removes a HyperNeo session's worktree on archive and delete.
- `neo.session.archive` admits only the user or a bound Neo session, and refuses while a todo is `doing` on the worker (`admitSessionArchive`).
- In flight, without a design so far, and kept as steps 1 and 2 below:
  - HyperNeo #10733 removes a worker's `builds`, `scratch` and `gh-config` once its worktree is gone.
  - HyperNeo #10735 archives the worker a todo started once the todo is `done`, on the todo runner's 5-minute sweep. It keeps a worker a human named, one another live todo is bound to, a remote one, and one with uncommitted or unpushed work; those are logged as pending and rechecked on the next sweep. Its final admission for an internal caller refuses while a `todo`, `doing` or `blocked` todo is bound to the worker. It records the release as a core `released` fact.

Gaps after those two:
- A `removed` todo never releases its worker.
- Unsaved work in a finished todo's folder is only logged; nobody is told.
- Evidence folders are never removed.
- Nothing checks for a running process inside a folder before removing it.
- No sweep finds leftovers, and no one watches free space.

## The model

A **work folder** is one folder the daemon created: a worker worktree, one of its `hn-*` work folders, or an evidence folder. Its **owner** is the record that created it: a todo-worker binding, or a HyperNeo session. Only these roots are swept: the daemon's `worktrees` and `projects/*/worktrees`, `work/{builds,scratch,gh-config,evidence}`, and inside the Codex worktrees root only threads a todo started. Human folders, human Codex threads and shared caches are never touched.

One pure rule, `planWorkRelease(facts)` (`lib/work-cleanup/plan.ts`), decides for every folder, first match wins:
1. no owner record: **keep** (`unknown`);
2. owner still live (todo `todo`, `doing`, `blocked` or `failed`; session not archived; another live todo bound to the worker): **keep**; an owner that cannot be read also keeps;
3. a process has its working folder inside: **keep** (`in_use`); a failed check also keeps;
4. uncommitted or unpushed work, or Git status that cannot be read: **keep** (`unsaved`);
5. evidence whose todo finished less than 7 days ago, or that something still references: **keep**. A reference is the evidence path in an open card, a live todo's `done_when`, check or instruction, or an artifact link; if the references cannot be read, keep;
6. otherwise: **remove**, with the evidence that allowed it (`todo done`, `todo removed`, `session archived`).

`failed` counts as live because Neo can still retry it. Step 3 adds `failed` to #10735's final internal admission, so the release and the sweep keep the same todos.

All facts are read through the daemon's own database interface. The live `daemon.db` is never copied.

## Release at the end

#10735's release runs for `done` and `removed` todos alike, and checks for a running process before the archive. The archive's existing cleanup removes the worktree, and #10733 then removes its work folders. An archived HyperNeo session's worktree release goes through the same rule.

## Daily backstop

`work.cleanup.sweep` is one superpipe, run once a day and once when the disk guard asks:
1. list the folders under the swept roots, and read their owner facts in one read;
2. pure `planWorkRelease` for each;
3. right before each removal, read that folder's owner and binding again and run `planWorkRelease` on the fresh facts, including the process check; remove only if it still says `remove`. A worker goes through #10735's release and its final admission, never a direct delete; its work folders go only through #10733, after the worktree is gone;
4. tell Neo one digest through the attention entry (`neo.attention.tell`, kind `work.cleanup`): space freed, and the kept folders grouped by reason.

It is idempotent and keeps no table. Each decision is logged with its evidence.

**Unsaved work is told, never deleted.** #10735 already keeps and logs it. What is new is the digest: a finished todo whose folder stays `unsaved` for 3 days goes to Neo with the todo and folder, once. Neo decides with the human; the daemon never discards changes.

## Disk guard

The todo runner's 5-minute sweep reads free space on the data volume:
- below the warning level (default 50 GiB): the attention entry tells Neo (digest);
- below the floor (default 10 GiB): it wakes Neo, runs the backstop once, and holds new worker starts. The start path already waits on capacity; a low disk is one more reason to wait. Running work continues.

Levels and ages are one core preference, `workCleanup {warnGiB, floorGiB, evidenceDays, unsavedNoticeDays}`.

## Files

```
packages/daemon/src/lib/work-cleanup/
  plan.ts            pure planWorkRelease
  sweep.ts           work.cleanup.sweep superpipe
  disk-guard.ts      pure decideDiskGuard(freeBytes, preference)
packages/daemon/src/lib/neo/todo-release.ts   removed todos; process check (on #10735)
packages/daemon/src/lib/neo/todo-runner.ts    disk guard on the 5-minute sweep; start hold
packages/daemon/src/lib/neo/attention/        kind work.cleanup
```

## Change plan

Each step is one PR within the repo's slice budget.
1. **#10733** (in flight): a worker's work folders go with its worktree.
2. **#10735** (in flight): a `done` todo archives the worker it started.
3. **Build + wire:** release for `removed` todos, `failed` in the final internal admission, and the process check before every removal. Tests: a removed todo's clean worker is archived; a folder with a running process inside is kept and retried; a worker bound to a `failed` todo is refused at final admission.
4. **Build:** `planWorkRelease` and `work.cleanup.sweep` with the digest. **Wire:** run it daily. Tests: each rule; a folder with no owner is never removed; a human Codex thread under the Codex root is never listed; evidence older than 7 days goes, younger stays, and old evidence referenced by an open card or a live todo stays; a todo rebound between the read and the removal keeps its folder; unsaved work is kept and told after 3 days, once.
5. **Build + wire:** the disk guard and the start hold. Tests: warning, floor, recovery above the floor releases the hold; running work is not stopped.

## Limits

- Shared caches (Cargo, Xcode, simulators) and folders a human made are not HyperNeo's; the machine's own cleanup handles them.
- Unsaved work is never deleted automatically.
- A worker on another daemon is cleaned by that daemon.
