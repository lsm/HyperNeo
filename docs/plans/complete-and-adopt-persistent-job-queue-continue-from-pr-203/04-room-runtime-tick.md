# Milestone 4: Migrate Room Runtime Tick

## Goal

Replace the `setInterval` + `scheduleTick()` + `scheduleTickAfterRateLimitReset()` + `queueMicrotask` pattern in `RoomRuntime` with persistent `room.tick` jobs. This is the highest-risk migration because room runtime manages agent sessions and task execution.

## Scope

- Create `room.tick` job handler
- Replace `setInterval` in `RoomRuntime.start()` with job-based scheduling
- Replace all `scheduleTick()` call sites (~17) with `enqueueRoomTick()`
- Replace all `scheduleTickAfterRateLimitReset()` call sites (6) with `enqueueRoomTick(roomId, jobQueue, delayMs)`
- Replace `queueMicrotask(() => this.tick())` call sites (2) with `enqueueRoomTick()`
- Replace `tickLocked`/`tickQueued` mutex with job-queue-level dedup
- Add pause/resume-aware job cancellation to prevent double ticks
- Fix `stopRuntime()` to call `runtimes.delete(roomId)`
- Add `stoppedRooms` tracking for liveness checks
- Wire handler through `RoomRuntimeService`
- Optional: feature flag `HYPERNEO_USE_JOB_QUEUE_ROOM_TICK` for rollback safety

## Scheduling Call Sites — Complete Inventory

The implementer **must not rely on hardcoded line numbers** — they will shift after Milestones 1-3 are merged. Instead, search dynamically:

```bash
grep -n 'this\.scheduleTick()' packages/daemon/src/lib/room/runtime/room-runtime.ts
grep -n 'this\.scheduleTickAfterRateLimitReset(' packages/daemon/src/lib/room/runtime/room-runtime.ts
grep -n 'queueMicrotask.*this\.tick' packages/daemon/src/lib/room/runtime/room-runtime.ts
```

**As of current `dev` branch, the complete inventory is:**

### `this.scheduleTick()` — 17 call sites
Lines: 259, 423, 432, 553, 560, 665, 1024, 1149, 1287, 1315, 1588, 1700, 1815, 3364, 3410, 3432, 3451

Of these, lines 3432 and 3451 are **inside** `scheduleTickAfterRateLimitReset()` and will be removed when that method is rewritten. So 15 external `scheduleTick()` sites need direct replacement.

### `this.scheduleTickAfterRateLimitReset(groupId)` — 6 call sites
Lines: 617, 696, 732, 985, 1052, 1084

Each of these must be replaced with `enqueueRoomTick(this.roomId, this.jobQueue, delayMs)` where `delayMs` is computed from `this.groupRepo.getRateLimitRemainingMs(groupId) + 5000` (the same logic currently in `scheduleTickAfterRateLimitReset()`). The delay computation must be **inlined at each call site** or extracted to a helper `getRateLimitDelay(groupId)` — the important thing is preserving the 5-second buffer.

### `queueMicrotask(() => this.tick())` — 2 call sites
Lines: 2241, 3421 (inside `scheduleTick()` body)

Line 3421 disappears when `scheduleTick()` is rewritten. Line 2241 must be replaced with `enqueueRoomTick(this.roomId, this.jobQueue, 0)`.

**Total: ~23 scheduling points** (15 external `scheduleTick` + 6 `scheduleTickAfterRateLimitReset` + 1 external `queueMicrotask` + the `setInterval` in `start()` = 23 distinct replacements).

## Pause/Resume and Dedup Design

### Current in-memory mutex

The current `RoomRuntime` uses `tickLocked` and `tickQueued` fields as a lightweight mutex:
- `tickLocked = true` while `tick()` is executing
- `tickQueued = true` if a tick request arrives while locked — ensures one queued tick

This in-memory state is lost when migrating to the job queue and must be replaced.

### Job-queue-level dedup

The `enqueueRoomTick()` helper handles dedup:
- Before enqueuing, check `jobQueue.listJobs({ queue: QUEUES.ROOM_TICK, status: ['pending'], limit: 100 })` and filter by `payload.roomId`. The limit of 100 is sufficient because this is a per-room dedup check (at most one pending tick per room), not a global scan.
- If **any** pending job exists for this roomId, skip enqueuing (regardless of `runAt`)
- Only `pending` status is checked, not `processing`. This is safe because: (a) a `processing` job is already executing and its handler's `finally` block will either re-schedule (if runtime is still `running`) or not (if `paused`/`stopped`); (b) if `pause()` is called while a job is `processing`, the handler detects the paused state and skips without re-scheduling — leaving zero pending ticks, which is correct; (c) checking `processing` would cause `enqueueRoomTick` to skip when a tick is actively running, but the running tick's `finally` block handles the successor.
- This replaces the `tickQueued` semantic: at most one pending tick exists per room

### Pause/resume interaction

**Problem:** After migration, `pause()` sets `this.state = 'paused'` but an already-enqueued `room.tick` job remains in the `pending` queue. When the processor picks it up, the handler checks `runtime.state !== 'running'` and skips — but the job still consumed a processing slot and the completed job's `finally` block might re-schedule.

**Solution:**
1. The `room.tick` handler's **first check** is `if (runtime.state !== 'running') return { skipped: true, reason: 'not running' }` — no re-schedule in finally when skipped
2. `pause()` must cancel pending tick jobs: call `cancelPendingTickJobs(this.roomId, this.jobQueue)` which finds all pending `room.tick` jobs for this roomId and deletes them (or marks them `dead`)
3. `resume()` calls `enqueueRoomTick(this.roomId, this.jobQueue, 0)` — a fresh tick is enqueued
4. The handler's `finally` block **only** re-schedules if the runtime is still in `running` state AND the handler was not skipped

This preserves the invariant: paused rooms have zero pending ticks, resumed rooms get exactly one.

### `cancelPendingTickJobs(roomId, jobQueue)` helper

```
function cancelPendingTickJobs(roomId: string, jobQueue: JobQueueRepository): void {
  const jobs = jobQueue.listJobs({ queue: QUEUES.ROOM_TICK, status: ['pending'], limit: 100 });
  for (const job of jobs) {
    if (job.payload?.roomId === roomId) {
      jobQueue.deleteJob(job.id);  // or mark as 'dead'
    }
  }
}
```

If `JobQueueRepository` lacks a `deleteJob` method, add one in Task 4.1.

## Key Files

- `packages/daemon/src/lib/room/runtime/room-runtime.ts` -- 3474 lines; `tickTimer` at line 157, `tickLocked`/`tickQueued` at lines 155-156, `setInterval` at line 422, `scheduleTick()` at line 3418, `queueMicrotask` at line 2241, `scheduleTickAfterRateLimitReset()` at line 3428, `pause()` at line 426, `resume()` at line 430
- `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` -- `stopRuntime()` at line 124, `startRuntime()` at line 135, `runtimes` Map at line 51

## Tasks

### Task 4.1: Create room.tick handler, enqueueRoomTick, and cancelPendingTickJobs helpers

**Description:** Create the `room.tick` job handler and helper functions for dedup-aware tick enqueuing and pause-aware cancellation. The handler calls `runtime.tick()` and re-schedules the next tick only if the runtime is still running. Add `deleteJob` to `JobQueueRepository` if it doesn't exist.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Check if `JobQueueRepository` has a `deleteJob(id)` method. If not, add one (simple `DELETE FROM job_queue WHERE id = ?`)
3. Create `packages/daemon/src/lib/job-handlers/room-tick.handler.ts`:
   - Handler extracts `{ roomId }` from job payload
   - Looks up runtime from a `getRuntimeForRoom` callback
   - If runtime not found or state is not 'running', return `{ skipped: true, reason: 'not running' }` — **do not re-schedule**
   - Call `await runtime.tick()`
   - In `finally` block: re-check `runtime.state === 'running'`, if still running call `enqueueRoomTick(roomId, jobQueue, tickInterval)`; if not, skip re-schedule
4. Create `enqueueRoomTick(roomId, jobQueue, delayMs?)` helper function:
   - Check for existing pending `room.tick` jobs for this room using `jobQueue.listJobs({ queue: QUEUES.ROOM_TICK, status: ['pending'], limit: 100 })`
   - Filter by `payload.roomId === roomId`
   - Only enqueue if **no pending job exists at all** for this roomId (not just "no future-scheduled job")
   - Default delay is 30,000ms (30s tick interval)
5. Create `cancelPendingTickJobs(roomId, jobQueue)` helper function:
   - Find all pending `room.tick` jobs for this roomId
   - Delete them via `jobQueue.deleteJob(id)`
6. Create unit test `packages/daemon/tests/unit/job-handlers/room-tick-handler.test.ts`:
   - Mock RoomRuntime with tick() stub
   - Test handler calls tick and re-schedules when runtime is running
   - Test handler skips and does NOT re-schedule when runtime not found
   - Test handler skips and does NOT re-schedule when runtime is paused
   - Test enqueueRoomTick dedup logic: second enqueue with existing pending job is a no-op
   - Test cancelPendingTickJobs removes all pending jobs for a given roomId
   - Test error in tick() still allows re-scheduling (if runtime still running)
7. Run tests and `bun run check`

**Acceptance criteria:**
- Handler exists and correctly calls `runtime.tick()`
- Handler does NOT re-schedule when runtime is not running or paused
- `enqueueRoomTick` deduplicates by roomId using "no pending job at all" check
- `cancelPendingTickJobs` removes all pending tick jobs for a room
- `deleteJob` method exists on `JobQueueRepository`
- Errors in tick do not break the scheduling chain for running runtimes
- Unit tests pass

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.2: Replace setInterval, scheduleTick, scheduleTickAfterRateLimitReset, and pause/resume in RoomRuntime

**Description:** Remove `setInterval` from `RoomRuntime.start()`, rewrite `scheduleTick()` and `scheduleTickAfterRateLimitReset()`, replace all call sites, update `pause()`/`resume()` to interact with the job queue, and remove the in-memory `tickLocked`/`tickQueued` mutex.

**IMPORTANT:** Do NOT rely on the line numbers listed below — they are approximate and will shift after Milestones 1-3. Use grep to find all call sites dynamically:
```bash
grep -n 'this\.scheduleTick()' room-runtime.ts
grep -n 'this\.scheduleTickAfterRateLimitReset(' room-runtime.ts
grep -n 'queueMicrotask.*this\.tick' room-runtime.ts
```

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`:
   - Add `jobQueue?: JobQueueRepository` to `RoomRuntimeConfig` interface
   - Store `jobQueue` in the constructor
   - Import `enqueueRoomTick`, `cancelPendingTickJobs` from the handler file
   - **Optional feature flag:** Check `process.env.HYPERNEO_USE_JOB_QUEUE_ROOM_TICK !== 'false'` to allow disabling the migration without a full revert. If `false`, fall back to the old `setInterval` behavior. (This is optional but recommended for rollback safety.)
2. In `start()`: Remove `this.tickTimer = setInterval(...)`, replace with `enqueueRoomTick(this.roomId, this.jobQueue, 0)` for immediate first tick
3. In `stop()`: Remove `clearInterval(this.tickTimer)` and `this.tickTimer = null`. Add `cancelPendingTickJobs(this.roomId, this.jobQueue)` to cancel any pending tick jobs.
4. Remove the `tickTimer` field
5. Remove `tickLocked` and `tickQueued` fields — dedup is now at the job queue level
6. Update `tick()` method: remove the `tickLocked`/`tickQueued` mutex logic at entry and exit. The job queue processor's `maxConcurrent` and the handler's structure already prevent concurrent ticks for the same room.
7. Rewrite `scheduleTick()`: instead of `queueMicrotask(() => this.tick())`, call `enqueueRoomTick(this.roomId, this.jobQueue, 0)` for immediate re-tick
8. Rewrite `scheduleTickAfterRateLimitReset(groupId)`:
   - Compute `delayMs = this.groupRepo.getRateLimitRemainingMs(groupId) + 5000` (preserve the 5s buffer)
   - If `delayMs <= 0`, call `enqueueRoomTick(this.roomId, this.jobQueue, 0)`
   - Otherwise call `enqueueRoomTick(this.roomId, this.jobQueue, delayMs)` — this replaces the `setTimeout` + `scheduleTick` pattern
   - Keep the log message for observability
9. Replace the standalone `queueMicrotask(() => this.tick())` at ~line 2241 with `enqueueRoomTick(this.roomId, this.jobQueue, 0)`
10. **Update `pause()`:** After setting `this.state = 'paused'`, call `cancelPendingTickJobs(this.roomId, this.jobQueue)` to drain any pending tick jobs
11. **Update `resume()`:** After setting `this.state = 'running'`, call `enqueueRoomTick(this.roomId, this.jobQueue, 0)` to start the tick chain fresh
12. Verify all ~23 scheduling points are addressed by running the grep commands above — there should be zero remaining matches
13. Run existing room runtime tests to check for breakage
14. Run `bun run check`

**Acceptance criteria:**
- No `setInterval` in `RoomRuntime`
- No `tickTimer`, `tickLocked`, or `tickQueued` fields
- `scheduleTick()` uses `enqueueRoomTick` instead of `queueMicrotask`
- `scheduleTickAfterRateLimitReset()` uses `enqueueRoomTick` with computed delay instead of `setTimeout`
- All 6 `scheduleTickAfterRateLimitReset` call sites preserved (they call the rewritten method)
- The standalone `queueMicrotask` at ~line 2241 replaced
- `pause()` cancels pending tick jobs
- `resume()` enqueues a fresh tick
- `tick()` method signature unchanged (still `async tick(): Promise<void>`)
- `grep -c 'setInterval\|queueMicrotask.*tick\|tickTimer\|tickLocked\|tickQueued' room-runtime.ts` returns 0
- TypeScript compiles without errors

**Depends on:** Task 4.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.3: Wire handler into RoomRuntimeService and fix stopRuntime bug

**Description:** Register the `room.tick` handler in `RoomRuntimeService`, fix `stopRuntime()` to delete from the `runtimes` map, and pass `jobQueue` to `RoomRuntime` instances. Ensure handler registration happens before `jobProcessor.start()` per the startup ordering in `00-overview.md`.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/room/runtime/room-runtime-service.ts`:
   - Add `jobQueue` and `jobProcessor` to `RoomRuntimeServiceConfig`
   - In `start()`: register the `room.tick` handler on `jobProcessor`. The handler needs access to `this.runtimes` map for runtime lookup by roomId.
   - Pass `jobQueue` to all `RoomRuntime` constructor calls (in `createOrGetRuntime`)
2. Fix `stopRuntime()` (line 124-129): after `runtime.stop()`, add `this.runtimes.delete(roomId)` so that the heartbeat liveness check works correctly
3. In `packages/daemon/src/app.ts`:
   - Pass `jobQueue` and `jobProcessor` to `RoomRuntimeServiceConfig`
   - Ensure `roomRuntimeService.start()` is called BEFORE `jobProcessor.start()` (per startup ordering: step 3 before step 5)
4. Update `packages/daemon/src/lib/rpc-handlers/index.ts` to forward `jobQueue` and `jobProcessor` to `RoomRuntimeService`
5. Update existing room runtime tests
6. Add unit test verifying:
   - Handler is registered on `start()`
   - `stopRuntime()` removes from runtimes map
   - `startRuntime()` creates runtime with jobQueue
7. Run `bun run check` and all daemon tests

**Acceptance criteria:**
- `room.tick` handler registered in `RoomRuntimeService.start()`
- `stopRuntime()` calls `this.runtimes.delete(roomId)`
- `jobQueue` passed to all `RoomRuntime` instances
- Handler registration happens BEFORE `jobProcessor.start()` in `app.ts`
- Existing room tests pass
- New tests verify handler registration and stopRuntime fix

**Depends on:** Task 4.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 4.4: Online test for room tick via job queue

**Description:** Create an online test verifying room ticks work end-to-end through the job queue, including dedup, pause/resume job cancellation, and recovery for stopped rooms.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/online/room/room-tick-job.test.ts`
2. Use `createDaemonServer()` and create a room
3. Verify:
   - `room.tick` job is enqueued when room runtime starts
   - Job processes and re-schedules
   - No duplicate tick jobs for the same room (at most one pending)
   - **Pause cancels pending ticks:** pause the runtime, verify no pending `room.tick` jobs for that room
   - **Resume enqueues fresh tick:** resume the runtime, verify a new tick job is enqueued
   - Stopping a room prevents further tick scheduling and cancels pending jobs
   - Restarting a room resumes tick scheduling
4. Run with `HYPERNEO_USE_DEV_PROXY=1`

**Acceptance criteria:**
- Online test verifies end-to-end room tick via job queue
- Dedup verified (at most one pending tick per room)
- Pause/resume lifecycle verified (pause cancels, resume enqueues)
- Stop/restart lifecycle verified
- Test runs with dev proxy

**Depends on:** Task 4.3

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
