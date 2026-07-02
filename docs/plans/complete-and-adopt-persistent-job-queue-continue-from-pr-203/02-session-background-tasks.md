# Milestone 2: Migrate Session Background Tasks

## Goal

Replace the fire-and-forget `pendingBackgroundTasks` Set in `SessionManager` with a persistent `session.title_generation` job. Title generation becomes durable and survives daemon restarts.

## Scope

- Create `session.title_generation` job handler
- Add `SessionManager.start()` method that registers the handler
- Remove `pendingBackgroundTasks` from `SessionManager`
- Replace fire-and-forget title generation with `jobQueue.enqueue()`

## Key Files

- `packages/daemon/src/lib/session/session-manager.ts` -- line 59 (`pendingBackgroundTasks`), lines 150-161 (title gen enqueue), lines 361-376 (cleanup drain)
- `packages/daemon/src/lib/session/session-lifecycle.ts` -- `generateTitleAndRenameBranch()` method
- `packages/daemon/src/storage/job-queue-processor.ts` -- handler registration
- `packages/daemon/src/app.ts` -- call ordering

## Tasks

### Task 2.1: Create session title generation job handler

**Description:** Create a job handler for `session.title_generation` that calls the existing `SessionLifecycle.generateTitleAndRenameBranch()` method. The handler extracts `sessionId` and `userMessageText` from the job payload.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root
2. Create `packages/daemon/src/lib/job-handlers/session-title.handler.ts`
3. Define the handler function: accepts a `Job`, extracts `{ sessionId, userMessageText }` from payload, calls `sessionLifecycle.generateTitleAndRenameBranch(sessionId, userMessageText)`
4. The handler should catch and log errors but not rethrow (title gen is non-fatal) -- actually, let errors propagate so the job queue retries
5. Return `{ generated: true }` on success
6. Create unit test `packages/daemon/tests/unit/job-handlers/session-title-handler.test.ts`:
   - Mock `SessionLifecycle` with a `generateTitleAndRenameBranch` stub
   - Test successful title generation
   - Test error propagation for retries
   - Test missing session handling
7. Run tests and `bun run check`

**Acceptance criteria:**
- Handler exists at `packages/daemon/src/lib/job-handlers/session-title.handler.ts`
- Handler calls `generateTitleAndRenameBranch` with correct params from payload
- Unit tests pass with mocked dependencies
- Errors propagate for job queue retry logic

**Depends on:** Task 1.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.2: Wire handler into SessionManager and remove pendingBackgroundTasks

**Description:** Add a `start()` method to `SessionManager` that registers the title generation handler with the job processor. Replace `pendingBackgroundTasks` usage with `jobQueue.enqueue()`. Update `app.ts` to call `sessionManager.start()` before `jobProcessor.start()`.

**Agent type:** coder

**Subtasks:**
1. In `packages/daemon/src/lib/session/session-manager.ts`:
   - Add `jobQueue: JobQueueRepository` and `jobProcessor: JobQueueProcessor` to constructor dependencies
   - Add `start()` method that registers the `session.title_generation` handler on `jobProcessor`
   - Replace lines 150-161 (the `pendingBackgroundTasks` tracking) with:
     ```
     this.jobQueue.enqueue({
       queue: QUEUES.SESSION_TITLE_GENERATION,
       payload: { sessionId, userMessageText },
       maxRetries: 2,
     });
     ```
   - Remove `private pendingBackgroundTasks: Set<Promise<unknown>>` field
   - Update `cleanup()` to remove the pendingBackgroundTasks drain logic (lines 361-376) -- the job processor handles draining
2. In `packages/daemon/src/app.ts`:
   - Pass `jobQueue` and `jobProcessor` to `SessionManager` constructor
   - Call `sessionManager.start()` after sessionManager creation but before `jobProcessor.start()`. Per the startup ordering in `00-overview.md`, `sessionManager.start()` is step 1, `jobProcessor.start()` is step 5. Ensure the handler registration happens before the processor starts so that any pending `session.title_generation` jobs from a previous run are processed correctly on restart.
3. Update existing `SessionManager` unit tests to account for constructor changes
4. Add unit test verifying `enqueue` is called instead of direct title generation
5. Run `bun run check` and all daemon tests

**Acceptance criteria:**
- `pendingBackgroundTasks` field completely removed from `SessionManager`
- Title generation enqueued as a job instead of fire-and-forget Promise
- `sessionManager.start()` registers the handler with `jobProcessor`
- `app.ts` calls `sessionManager.start()` in correct order
- All existing session-related tests pass
- Cleanup no longer drains background tasks (processor handles this)

**Depends on:** Task 2.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 2.3: Online test for session title generation via job queue

**Description:** Create an online test that verifies title generation works end-to-end through the job queue, including retry on failure.

**Agent type:** coder

**Subtasks:**
1. Create `packages/daemon/tests/online/lifecycle/session-title-job.test.ts`
2. Use `createDaemonServer()` test helper to spin up a daemon
3. Create a session, send a message, and verify:
   - A `session.title_generation` job is enqueued
   - The job is processed (status transitions: pending -> processing -> completed)
   - The session title is updated
4. Test retry behavior: mock title generation to fail on first attempt, succeed on second
5. Run with `HYPERNEO_USE_DEV_PROXY=1` for mocked API calls

**Acceptance criteria:**
- Online test verifies end-to-end title generation via job queue
- Job status transitions are verified
- Retry on failure is tested
- Test runs successfully with dev proxy

**Depends on:** Task 2.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
