# Milestone 6: Integration Tests and E2E Validation

## Goal

Comprehensive integration tests verifying crash-recovery, job resumption after restart, and end-to-end validation that all migrated subsystems work together through the job queue.

## Scope

- Online integration tests for crash-recovery across all migrated subsystems
- Verify job processing resumes correctly after daemon restart
- Verify no regressions in existing functionality
- Clean up any remaining stale in-memory patterns
- Audit and document out-of-scope `setInterval` usage

## Tasks

### Task 6.1: Integration test -- job queue crash recovery

**Description:** Create integration tests that simulate daemon crash/restart scenarios and verify all job types resume correctly.

**Important implementation note:** `createDaemonServer()` typically creates a fresh database. For crash-recovery tests, you must explicitly configure a **file-backed SQLite database** that persists across daemon instances. Pass the same database path to both the first and second daemon instances so that jobs from the first run survive into the second run.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/tests/online/features/job-queue-crash-recovery.test.ts`
3. Configure tests to use a **file-backed SQLite database** (e.g., `tmp/test-crash-recovery.db`) that persists across daemon restarts
4. Test scenarios:
   - **Session title gen recovery:** Enqueue a title gen job, stop daemon before completion, restart daemon with same DB, verify job is reclaimed and processed (should happen immediately due to eager `reclaimStale()`)
   - **GitHub poll chain recovery:** Start daemon with GitHub polling, stop daemon mid-poll, restart, verify poll chain resumes without manual intervention
   - **Room tick recovery:** Create a room, start ticking, stop daemon, restart, verify room ticks resume
   - **Cleanup job recovery:** Enqueue cleanup job, stop daemon before it runs, restart, verify cleanup runs
5. Each test uses `createDaemonServer()` with explicit DB path, enqueues jobs, stops daemon, then creates a fresh daemon against the same database file
6. Clean up temporary database files in `afterEach`/`afterAll`
7. Run with `HYPERNEO_USE_DEV_PROXY=1`

**Acceptance criteria:**
- All four crash-recovery scenarios pass
- Jobs transition correctly through status changes
- No lost jobs after restart
- Self-scheduling chains resume correctly
- Eager stale reclamation verified (jobs reclaimed immediately, not after 60s)
- File-backed DB used (not in-memory)

**Depends on:** Task 2.2, Task 3.2, Task 4.3, Task 5.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 6.2: Cleanup stale in-memory patterns, audit setInterval usage, and final verification

**Description:** Remove any remaining dead code from the pre-migration patterns. Audit all `setInterval` usage in the daemon codebase and document which are in-scope (migrated) and which are out-of-scope (with reasons). Run the full test suite to verify no regressions.

**Agent type:** coder

**Subtasks:**
1. Search for remaining `setInterval` patterns in daemon code:
   - Confirm `GitHubPollingService` has no `setInterval`
   - Confirm `RoomRuntime` has no `setInterval`, `tickTimer`, `tickLocked`, or `tickQueued`
   - Confirm `SessionManager` has no `pendingBackgroundTasks`
2. **Audit all remaining `setInterval` usage** and verify they are out-of-scope:
   - `WebSocketServerTransport.staleCheckTimer` — transport-layer health check, not a business task → out of scope
   - `SpaceRuntime.tickTimer` — separate runtime subsystem, migrate in follow-up → out of scope
   - `TaskAgentManager` polling interval — part of SpaceRuntime subsystem → out of scope
   - `JobQueueProcessor` internal poll timer — this IS the job queue infrastructure → out of scope
   - `app.ts` shutdown readiness check — one-shot shutdown polling → out of scope
3. Add a code comment in `app.ts` (near the job queue setup) documenting the out-of-scope `setInterval` users for future reference, e.g.:
   ```
   // Out-of-scope setInterval users (not migrated to job queue):
   // - WebSocketServerTransport.staleCheckTimer (transport-layer health check)
   // - SpaceRuntime.tickTimer (separate runtime, migrate in follow-up)
   // - TaskAgentManager polling (part of SpaceRuntime)
   // - JobQueueProcessor internal poll (job queue infrastructure itself)
   // - app.ts shutdown readiness check (one-shot)
   ```
4. Run `bun run check` (lint + typecheck + knip) to catch dead exports
5. Run `make test-daemon` for full daemon test suite
6. Run `make test-web` for full web test suite
7. Fix any failures found
8. Create a summary of all changes made across the milestone

**Acceptance criteria:**
- No `setInterval` for background tasks in migrated subsystems
- No `pendingBackgroundTasks` in SessionManager
- All remaining `setInterval` usage documented as out-of-scope with reasons
- `bun run check` passes (no lint, type, or dead export errors)
- All daemon tests pass
- All web tests pass

**Depends on:** Task 6.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 6.3: E2E test for job queue health indicator (optional)

**Description:** If time permits, add a minimal E2E test that verifies background tasks continue working from the user's perspective -- sessions get titles, rooms tick, etc.

**Agent type:** coder

**Subtasks:**
1. Create `packages/e2e/tests/features/job-queue-background-tasks.e2e.ts`
2. Test via UI:
   - Create a session, send a message, verify the session title updates (title gen job worked)
   - If room UI is available: create a room, verify it shows activity (ticks are happening)
3. All assertions through visible DOM state per E2E rules

**Acceptance criteria:**
- E2E test verifies background tasks work from user perspective
- Session title generation visible in UI
- All assertions via DOM state

**Depends on:** Task 6.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
