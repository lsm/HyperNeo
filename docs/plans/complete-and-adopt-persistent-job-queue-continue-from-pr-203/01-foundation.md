# Milestone 1: Foundation -- Wire JobQueueProcessor into DaemonApp

## Goal

Make the persistent job queue operational by wiring `JobQueueProcessor` into the daemon lifecycle, extending `listJobs` to support status arrays, creating queue name constants, connecting the change notifier to `ReactiveDatabase`, and adding eager stale job reclamation on startup.

## Scope

- Extend `JobQueueRepository.listJobs()` to accept `status` as `JobStatus | JobStatus[]`
- Create `packages/daemon/src/lib/job-queue-constants.ts` with queue name constants
- Instantiate `JobQueueProcessor` in `app.ts`
- Connect `setChangeNotifier` to `ReactiveDatabase`
- Add `jobProcessor` and `jobQueue` to `DaemonAppContext`
- Hook `jobProcessor.stop()` into cleanup (before `messageHub.cleanup()`)
- Pass `jobQueue` and `jobProcessor` through `RPCHandlerDependencies`
- Add eager `reclaimStale()` call in `JobQueueProcessor.start()` for instant crash recovery

## Tasks

### Task 1.1: Extend listJobs to accept status arrays

**Description:** Modify `JobQueueRepository.listJobs()` to accept `status` as either a single `JobStatus` string or an array of `JobStatus` values. When an array is provided, generate `IN (?,?,...)` SQL with dynamic placeholders. Empty array returns no rows.

**Agent type:** coder

**Subtasks:**
1. Read `packages/daemon/src/storage/repositories/job-queue-repository.ts` lines 128-147
2. Change the `status` field type in the filter parameter from `status?: JobStatus` to `status?: JobStatus | JobStatus[]`
3. Update the SQL generation: if array, build `AND status IN (?,?,...)`; if string, keep existing `AND status = ?`; if empty array, return `[]` early
4. Update `packages/daemon/tests/unit/storage/job-queue-repository.test.ts` with tests for:
   - `status: ['pending', 'processing']` returns jobs matching either status
   - `status: 'pending'` (string) still works as before
   - `status: []` (empty array) returns empty results
5. Run `cd packages/daemon && bun test tests/unit/storage/job-queue-repository.test.ts` to verify
6. Run `bun run check` to verify no lint/type errors

**Acceptance criteria:**
- `listJobs({ status: ['pending', 'processing'] })` returns jobs with either status
- `listJobs({ status: 'pending' })` still works (backward compatible)
- `listJobs({ status: [] })` returns empty array
- All existing job-queue-repository tests pass
- New tests cover the array status filter

**Depends on:** none

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.2: Create job queue constants, wire processor into app.ts, and add eager stale reclamation

**Description:** Create the queue name constants file and wire `JobQueueProcessor` into the `DaemonApp` lifecycle. This includes instantiation, ReactiveDatabase change notification, cleanup ordering, and exposing via `DaemonAppContext`. Also modify `JobQueueProcessor.start()` to eagerly reclaim stale jobs on startup (before the first poll tick) so crash-recovery is instant rather than delayed by up to 60 seconds.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/src/lib/job-queue-constants.ts` with constants:
   ```
   SESSION_TITLE_GENERATION = 'session.title_generation'
   GITHUB_POLL = 'github.poll'
   ROOM_TICK = 'room.tick'
   JOB_QUEUE_CLEANUP = 'job_queue.cleanup'
   ```
3. In `packages/daemon/src/storage/job-queue-processor.ts`:
   - In `start()`, add `this.repo.reclaimStale(this.staleThresholdMs)` call **before** the first `this.tick()` call. This ensures any jobs left in `processing` from a previous crash are immediately reclaimed on startup, rather than waiting for the 60s `STALE_CHECK_INTERVAL`
   - Add a unit test specifically for this eager reclamation behavior
4. In `packages/daemon/src/app.ts`:
   - Import `JobQueueRepository` from `./storage/repositories/job-queue-repository`
   - Import `JobQueueProcessor` from `./storage/job-queue-processor`
   - After `liveQueries` creation (~line 101), instantiate:
     ```
     const jobQueue = new JobQueueRepository(db.getDatabase());
     const maxConcurrent = Number(process.env.HYPERNEO_JOB_QUEUE_MAX_CONCURRENT) || 5;
     const jobProcessor = new JobQueueProcessor(jobQueue, { pollIntervalMs: 1000, maxConcurrent, staleThresholdMs: 5 * 60 * 1000 });
     ```
   - Call `jobProcessor.setChangeNotifier((table) => { reactiveDb.notifyChange(table); });`
   - **IMPORTANT startup ordering:** `jobProcessor.start()` must be the **last** startup call, placed AFTER all handler registrations. Initially (before Milestones 2-4 add their handlers), place it after `gitHubService.start()` (~line 341). Each subsequent milestone will insert handler registrations before this call.
   - In `cleanup()`, add `await jobProcessor.stop()` BEFORE `messageHub.cleanup()` (~line 394) with log message
5. Add `jobProcessor: JobQueueProcessor` and `jobQueue: JobQueueRepository` to `DaemonAppContext` interface and return object
6. Add `jobProcessor` and `jobQueue` to `RPCHandlerDependencies` in `packages/daemon/src/lib/rpc-handlers/index.ts` (interface only, no handler changes yet)
7. Pass `jobProcessor` and `jobQueue` from `app.ts` to `setupRPCHandlers()`
8. Run `bun run check` to verify no lint/type errors
9. Create unit test `packages/daemon/tests/unit/app/job-queue-lifecycle.test.ts` that verifies:
   - `DaemonAppContext` includes `jobProcessor` and `jobQueue`
   - Cleanup stops the processor before messageHub
   - `maxConcurrent` is configurable via env var

**Acceptance criteria:**
- `JobQueueProcessor` is instantiated in `app.ts` with `maxConcurrent` defaulting to 5 (configurable via `HYPERNEO_JOB_QUEUE_MAX_CONCURRENT`)
- Eager `reclaimStale()` called in `start()` before first poll tick
- Change notifier wired to `reactiveDb.notifyChange`
- `jobProcessor.start()` called AFTER all handler registrations
- `jobProcessor.stop()` called in cleanup BEFORE `messageHub.cleanup()`
- `jobProcessor` and `jobQueue` available in `DaemonAppContext`
- `RPCHandlerDependencies` interface includes both fields
- Constants file exists with all 4 queue names
- All existing tests pass

**Depends on:** Task 1.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 1.3: Unit tests for processor lifecycle integration

**Description:** Add unit tests verifying the `JobQueueProcessor` contract **in isolation** — specifically the behavioral contracts that the app-level wiring depends on. This focuses on processor internals (polling, dequeue, handler dispatch, stale reclamation, error/retry) and does NOT test app-level wiring (which is covered by Task 1.2's test file).

**Scope clarification vs Task 1.2 tests:**
- **Task 1.2** (`app/job-queue-lifecycle.test.ts`) tests app-level wiring: context fields, cleanup ordering, env var config
- **Task 1.3** (`storage/job-queue-processor-lifecycle.test.ts`) tests processor contract: start → poll → dequeue → dispatch → stop, change notification callbacks, error → retry → dead transitions, stale reclamation timing, eager reclaim on start

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/unit/storage/job-queue-processor-lifecycle.test.ts`
2. Test that `start()` calls `reclaimStale()` eagerly before the first poll tick
3. Test that `start()` begins polling and processes enqueued jobs via registered handlers
4. Test that `stop()` waits for in-flight jobs to complete before resolving
5. Test that `setChangeNotifier` callback is invoked when jobs complete (status transitions)
6. Test that processor handles handler errors gracefully: first failure increments `attempts` and re-queues as `pending`; after `maxRetries` exhausted, marks as `dead`
7. Test that stale job reclamation works: a job stuck in `processing` beyond `staleThresholdMs` is reset to `pending`
8. Run `cd packages/daemon && bun test tests/unit/storage/job-queue-processor-lifecycle.test.ts`

**Acceptance criteria:**
- Tests cover eager stale reclamation on start
- Tests cover start → poll → dequeue → dispatch lifecycle
- Tests cover stop draining in-flight jobs
- Tests cover change notification callback invocation
- Tests cover error → retry → dead transitions
- Tests cover stale job reclamation timing
- No overlap with Task 1.2's app-wiring tests
- All tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
