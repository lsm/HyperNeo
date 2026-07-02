# Milestone 5: Integration and E2E Tests

## Goal

Add online integration tests and Playwright E2E tests to validate the full lifecycle: reactivation from completed/cancelled, archive as terminal state with worktree cleanup, and the new UI tab grouping.

## Scope

- Online integration tests in `packages/daemon/tests/online/`
- E2E Playwright tests in `packages/e2e/tests/`

---

### Task 5.1: Online integration tests for task reactivation and archive

**Description:** Add online tests that exercise the full task lifecycle including reactivation from completed/cancelled and archiving. These tests run against a real daemon with mocked SDK (dev proxy).

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/daemon/tests/online/rpc/rpc-task-lifecycle.test.ts` (or add to existing `rpc-task-draft-handlers.test.ts` if appropriate):
   - Test: Create a task, move through `pending -> in_progress -> completed`, then reactivate to `in_progress`, verify the task group is revived and worktree exists.
   - Test: Create a task, move through `pending -> in_progress -> cancelled`, then reactivate to `in_progress`, verify the task group is reset and worktree exists.
   - Test: Create a task, complete it, then archive it. Verify the worktree is cleaned up and status is `archived`.
   - Test: Verify that `archived` tasks cannot transition to any other status (returns error).
   - Test: Verify `task.list` excludes archived tasks by default, and includes them with `includeArchived: true`.
   - Test: Send a human message to a `completed` task, verify it auto-reactivates to `in_progress`.
   - Test: Send a human message to an `archived` task, verify it fails.
3. Use `HYPERNEO_USE_DEV_PROXY=1` for mocked SDK tests.
4. Run: `HYPERNEO_USE_DEV_PROXY=1 cd packages/daemon && bun test tests/online/rpc/rpc-task-lifecycle.test.ts`.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All online tests pass with dev proxy.
- Tests cover the full lifecycle: create -> complete -> reactivate -> archive.
- Tests verify worktree preservation on complete/cancel and cleanup on archive.
- Tests verify `task.list` filtering with `includeArchived`.
- Tests verify messaging auto-reactivation.

**Dependencies:** Tasks 2.4, 3.2

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**

---

### Task 5.2: E2E Playwright tests for reactivate and archive UI actions

**Description:** Add Playwright E2E tests that exercise the new UI actions: reactivating a completed/cancelled task and archiving a task through the browser UI.

**Agent type:** coder

**Setup note:** Getting a task into `completed` state through the full UI flow is expensive. Per CLAUDE.md E2E rules, RPC calls are **allowed for setup/teardown** (e.g., `beforeEach`/`afterEach`). Use RPC to create a room, create a task, and advance it to `completed`/`cancelled` state in the test setup. All **test actions and assertions** must go through the UI (clicks, visible DOM state).

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Create `packages/e2e/tests/features/task-lifecycle.e2e.ts`:
   - **Setup (RPC allowed):** Create a room and tasks in various states (`completed`, `cancelled`, `needs_attention`) via RPC calls in `beforeEach`.
   - **Test:** Navigate to a completed task, click "Reactivate", verify the task status changes to `in_progress` in the UI (visible status badge update).
   - **Test:** Navigate to a completed task, click "Archive", confirm the dialog, verify the task disappears from the Done tab and appears in the Archived tab.
   - **Test:** Verify that archived tasks appear under the Archived tab and not in the Done tab.
   - **Test:** Verify that the Archive confirmation dialog mentions permanent worktree cleanup.
   - **Test:** Navigate to a completed task, type a message and send it, verify the task auto-reactivates (status changes in the UI).
   - **Teardown (RPC allowed):** Clean up rooms and tasks via RPC.
3. Follow E2E test rules from CLAUDE.md: all test actions through UI clicks, all assertions on visible DOM state. RPC only for setup/teardown.
4. Run: `make run-e2e TEST=tests/features/task-lifecycle.e2e.ts`.
5. Run `bun run lint` and `bun run format`.

**Acceptance criteria:**
- All E2E tests pass.
- Tests exercise real browser interactions for all assertions (no RPC shortcuts in test body).
- Tests verify visible UI state changes (status badges, tab membership, dialog content).
- Test setup uses RPC to efficiently create tasks in desired states.

**Dependencies:** Tasks 4.3, 5.1

**Changes must be on a feature branch with a GitHub PR created via `gh pr create`.**
