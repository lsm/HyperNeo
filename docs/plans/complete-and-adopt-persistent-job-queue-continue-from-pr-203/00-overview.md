# Complete and Adopt Persistent Job Queue -- Continue from PR #203

## Goal

Wire the existing but unused `JobQueueRepository` and `JobQueueProcessor` into the daemon lifecycle, then migrate the three primary `setInterval`-based background task subsystems to the persistent job queue. This makes background work durable across daemon restarts and centralizes scheduling.

## Background

PR #203 produced a comprehensive ADR (`docs/adr/0002-job-queue-migration.md`) over 13 review iterations. The plan is well-specified but zero production code has been implemented. The existing infrastructure includes:

- `JobQueueRepository` (complete, 203 lines) -- CRUD, dequeue, retry, cleanup
- `JobQueueProcessor` (complete, 123 lines) -- poll-based processor with handler registration
- `job_queue` SQLite table with indexes
- Comprehensive unit tests for both

The subsystems to migrate:
1. **Session background tasks** -- fire-and-forget title generation tracked in `pendingBackgroundTasks` Set
2. **GitHub polling** -- `setInterval` in `GitHubPollingService` (60s cycle)
3. **Room runtime tick** -- `setInterval` in `RoomRuntime.start()` (30s cycle), with **17 `scheduleTick()` call sites**, **6 `scheduleTickAfterRateLimitReset()` call sites** (lines 617, 696, 732, 985, 1052, 1084), and **2 `queueMicrotask(() => this.tick())` call sites** (lines 2241, 3421) — totaling ~23 scheduling points that need migration

## Out of Scope

The following `setInterval` users are explicitly **out of scope** for this migration and will remain as-is:

- **`WebSocketServerTransport.staleCheckTimer`** (`packages/daemon/src/lib/websocket-server-transport.ts` line 87) — This is a transport-layer health check (30s stale connection cleanup), not a background business task. It operates at a different abstraction layer and does not benefit from persistence.
- **`SpaceRuntime.tickTimer`** (`packages/daemon/src/lib/space/runtime/space-runtime.ts` line 226) — SpaceRuntime is a newer/parallel runtime implementation. Its tick loop follows the same pattern as RoomRuntime but is a separate subsystem. It should be migrated in a follow-up once RoomRuntime migration is proven stable.
- **`TaskAgentManager` polling interval** (`packages/daemon/src/lib/space/runtime/task-agent-manager.ts` line 190) — Part of the SpaceRuntime subsystem, out of scope for the same reason.
- **`JobQueueProcessor` internal poll timer** (`packages/daemon/src/storage/job-queue-processor.ts` line 38) — This is the job queue infrastructure itself; its internal `setInterval` is the mechanism that drives all job processing and is not a migration target.
- **`app.ts` shutdown readiness check** (`packages/daemon/src/app.ts` line 367) — One-shot `setInterval` for graceful shutdown polling, not a recurring background task.

Task 6.2 must explicitly verify these exclusions and document them in a code comment for future reference.

## Approach

Continue on the existing PR #203 branch (`plan/persistent-job-queue-adoption`). Implement in 6 milestones, each producing a PR-ready commit. All work targets the `dev` branch.

**Key design decisions:**
- Handlers self-schedule the next run (no dedicated scheduler service for now)
- `listJobs` must be extended to accept `status` as an array for deduplication queries
- Room tick deduplication uses application-level checks (not DB unique index) for simplicity. **Risk acknowledged:** the check-then-enqueue pattern has a small race window. If this proves problematic in practice, a follow-up can add a unique partial index on `(queue, json_extract(payload, '$.roomId')) WHERE status IN ('pending', 'processing')` as the ADR suggests. For now the application-level approach is acceptable because: (a) SQLite serializes writes, limiting the race window; (b) a rare duplicate tick is harmless (tick is idempotent); (c) the dedup check should use "no pending job exists at all for this roomId" (not just "no future-scheduled job"), see detailed logic in Milestone 4.
- `stopRuntime()` must call `runtimes.delete(roomId)` to fix the liveness check bug
- **Pause/resume must cancel in-flight tick jobs** — see Milestone 4 for detailed design of pause/resume interaction with the job queue

## Handler Registration and Startup Ordering

All handlers **must** be registered before `jobProcessor.start()` is called. If a pending job exists in the DB from a previous run and no handler is registered for its queue, it will fail with "No handler registered" and consume retry attempts.

**Required startup order in `app.ts`:**

```
1. sessionManager.start()       → registers 'session.title_generation' handler
2. gitHubService.start()        → registers 'github.poll' handler + enqueues initial poll
3. roomRuntimeService.start()   → registers 'room.tick' handler
4. Register cleanup handler     → registers 'job_queue.cleanup' handler + enqueues initial cleanup
5. jobProcessor.start()         → begins processing (all handlers now registered)
```

Each milestone's wiring task must respect this ordering. Task 1.2 must initially call `jobProcessor.start()` as the **last** step, and each subsequent milestone inserts its handler registration before that call.

## maxConcurrent Configuration

The initial `maxConcurrent: 3` is conservative. With multiple active rooms, each generating `room.tick` jobs every 30s, plus GitHub polling and title generation, the 3-slot limit may cause contention — a long-running title generation or poll could block room ticks.

**Mitigation strategy:**
- Start with `maxConcurrent: 5` instead of 3, based on expected workload (typically 1-3 active rooms + 1 GitHub poll + occasional title gen)
- The processor's `dequeue` already handles priority via FIFO ordering; room ticks are short-lived and will cycle quickly
- If contention appears in practice, the follow-up is per-queue concurrency limits (the ADR's open question on priority inversion)
- Task 1.2 should make `maxConcurrent` configurable via environment variable (`HYPERNEO_JOB_QUEUE_MAX_CONCURRENT`, default 5)

## Stale Job Reclamation Timing

`JobQueueProcessor.checkStaleJobs()` runs only after `STALE_CHECK_INTERVAL = 60_000ms` has elapsed since the last check. After a daemon restart, jobs stuck in `processing` from the previous run will sit unreclaimed for up to 60 seconds.

**Mitigation:** Task 1.2 must add an eager `reclaimStale()` call in `JobQueueProcessor.start()` — immediately after starting, reclaim any stale jobs before the first poll tick. This ensures crash-recovery is instant rather than delayed by up to 60 seconds.

## Rollback Strategy

Each milestone removes old scheduling code (`setInterval`, `pendingBackgroundTasks`, etc.) and replaces it with job queue calls. If a milestone causes issues:

1. **Revert the merge commit** for that milestone's PR — this restores the old `setInterval` code
2. Old jobs in the `job_queue` table for the reverted subsystem will go stale and be cleaned up by the cleanup job (or manually via `DELETE FROM job_queue WHERE queue = '...'`)
3. The job queue infrastructure (Milestone 1) can remain in place even if individual migrations are reverted

For the highest-risk migration (Milestone 4 — room tick), the implementer should ensure the PR is small enough to revert cleanly and should include a feature flag or environment variable (`HYPERNEO_USE_JOB_QUEUE_ROOM_TICK=true`) that can disable the migration without a full revert.

## Milestones

1. **Foundation -- Wire JobQueueProcessor into DaemonApp** -- Instantiate processor in `app.ts`, add constants file, extend `listJobs` to accept status arrays, connect change notifier to ReactiveDatabase, hook into start/stop lifecycle. Add eager stale reclamation on startup.

2. **Migrate Session Background Tasks** -- Replace `pendingBackgroundTasks` Set in `SessionManager` with a `session.title_generation` job queue handler. Add `SessionManager.start()` method.

3. **Migrate GitHub Polling** -- Replace `setInterval` in `GitHubPollingService` with self-scheduling `github.poll` jobs. Expose `triggerPoll()` method, register handler, add dedup logic in finally block.

4. **Migrate Room Runtime Tick** -- Replace `setInterval` + `scheduleTick()` + `scheduleTickAfterRateLimitReset()` + `queueMicrotask` in `RoomRuntime` with `room.tick` jobs. Fix `stopRuntime()` to delete from runtimes map. Handle all ~23 scheduling call sites. Add pause/resume-aware job cancellation.

5. **Database Cleanup Job and Stale Job Reclamation** -- Add a self-scheduling `job_queue.cleanup` job that runs daily. Remove old completed/dead jobs. Verify stale job reclamation works across restarts.

6. **Integration Tests and E2E Validation** -- Online tests for crash-recovery scenarios across all migrated subsystems. Verify job processing resumes after daemon restart. Audit for remaining `setInterval` usage and document out-of-scope exclusions.

## Cross-Milestone Dependencies

```
Milestone 1 (Foundation)
  +-- Milestone 2 (Session tasks)
  +-- Milestone 3 (GitHub polling)
  +-- Milestone 4 (Room tick)
  +-- Milestone 5 (Cleanup job)
       |
       +-- Milestone 6 (Integration tests) -- depends on Milestones 2, 3, 4, 5
```

Milestones 2, 3, 4, and 5 can proceed in parallel after Milestone 1 is complete. Milestone 6 depends on all prior milestones.

## Total Estimated Task Count

18 tasks across 6 milestones (3 + 3 + 3 + 4 + 2 + 3).
