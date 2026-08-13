# Milestone 6 — Tests and Validation

## Goal

Add comprehensive unit tests, integration tests, and validation to confirm the short ID system works end-to-end: multi-tenant isolation, backward compatibility with UUID-only records, short ID stability across daemon restarts, and no regressions in existing functionality.

## Context

By this milestone, all coding work from Milestones 1–5 is complete. This milestone focuses on:
1. Multi-tenant isolation proof: counters in different rooms are independent
2. Daemon restart stability: short IDs written to DB survive daemon restart
3. Backward compat: UUID-only records (old tasks/goals without `short_id`) still work everywhere
4. No regression: all existing tests still pass, no UUID-based functionality broken
5. Online test: verify the full flow using a live daemon (using the dev proxy or real API)

## Tasks

---

### Task 6.1 — Multi-Tenant Isolation Unit Tests

**Description**: Write targeted unit tests proving that short ID counters are scoped per room and do not bleed across rooms.

**Subtasks**:
1. Create `packages/daemon/tests/unit/short-id/multi-tenant.test.ts`
2. Test cases:
   - Create tasks in Room A (`t-1`, `t-2`, `t-3`) and Room B (`t-1`, `t-2`) — assert they are completely independent
   - Attempt to look up Room A's `t-1` using Room B's `getTaskByShortId` — assert it returns `null`
   - Create goals in Room A and Room B — assert `g-1` exists in both independently
   - Verify `short_id_counters` table has separate rows for each `(entity_type, scope_id)` pair
3. Use an in-memory SQLite database for speed (no external dependencies)

**Acceptance Criteria**:
- Room A and Room B both have `t-1` tasks with different UUIDs
- Cross-room lookup returns `null`
- All tests pass

**Depends on**: Milestone 2 complete

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 6.2 — Backward Compatibility Unit Tests

**Description**: Write tests covering the legacy path — tasks and goals that exist in the DB without a `short_id` value (simulating records created before this feature was deployed).

**Note on scope**: This task is **tests-only**. The lazy backfill implementation in `listTasks` was already added to `TaskRepository` in Task 2.2 and the analogous method in `GoalRepository` in Task 2.3. This task verifies correctness of that implementation with targeted backward-compat tests.

**Subtasks**:
1. Create `packages/daemon/tests/unit/short-id/backward-compat.test.ts`
2. Test cases:
   - Insert a raw task row into the DB without `short_id` (simulating a legacy record — use direct SQL `INSERT` to bypass `TaskRepository.createTask`)
   - Call `getTask(id)` on the legacy record — assert it returns a valid `NeoTask` (with `shortId` assigned via lazy backfill)
   - Call `task.get` RPC handler with the UUID of the legacy record — assert it succeeds and returns `shortId`
   - Call `task.get` RPC handler with a short ID for the legacy record — assert it resolves (since backfill assigned one on the previous UUID-based call)
   - Assert that `task.list` for a room with a mix of new tasks (with `short_id`) and old tasks (without) returns all tasks with `shortId` populated for all rows (backfill already implemented in Task 2.2)

**Acceptance Criteria**:
- Legacy tasks (no `short_id` in DB) work with UUID-based API calls
- Lazy backfill on `getTask` assigns a short ID to legacy tasks on first read
- `task.list` returns all tasks (legacy and new) without errors
- Backward compat tests pass

**Depends on**: Milestone 3 complete

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 6.3 — Online Integration Test: Full Short ID Flow

**Description**: Write an online integration test (in `packages/daemon/tests/online/`) that exercises the full short ID lifecycle through the daemon.

**Subtasks**:
1. Create `packages/daemon/tests/online/room/short-id-flow.test.ts`
2. Test flow:
   a. Create a room via `room.create` RPC
   b. Create two tasks via `task.create` — assert both have `shortId` in the response (`t-1`, `t-2`)
   c. Fetch each task by short ID via `task.get` with `taskId: 't-1'` — assert correct task returned
   d. Create a goal via `goal.create` — assert `shortId` is `g-1`
   e. Fetch `room.overview` — assert task summaries include `shortId`
   f. Create another room and create a task — assert its `shortId` is also `t-1` (independent counter)
   g. Clean up rooms via `room.delete`
3. Add the test module to CI in **two places** (keep them consistent):
   - In `.github/workflows/` YAML (the online test matrix), add an entry for the new test file under the `room` module group
   - In `scripts/validate-test-matrix.sh` (the universal test-coverage guard, wired into `bun run check` and CI), add `short-id-flow.test.ts` to the `ROOM_FILES` array so the guard recognizes it as covered by the `room` shard — an uncovered file fails the build rather than being silently skipped
   - **The YAML row and the `ROOM_FILES` entry must agree.** The guard's `check_split_module "room"` requires an ACTIVE `room` matrix `test_path` for every file in `ROOM_FILES`; pairing a `ROOM_FILES` entry with a commented-out YAML row fails `bun run check` (the guard sees the file but no active coverage). So: if room online tests are intentionally disabled (commented out for resource reasons), do NOT add the file to `ROOM_FILES` yet — leave it out until the room shard is re-enabled, and record the gating in the test file header comment.
4. Run with `cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/room/short-id-flow.test.ts`

**Acceptance Criteria**:
- Task `shortId` values are `t-1`, `t-2`, etc. in creation order per room
- Goal `shortId` is `g-1`
- Cross-room isolation verified: two rooms each have independent `t-1`
- `room.overview` includes `shortId` in task summaries
- Test passes with dev proxy

**Depends on**: Task 6.1, Task 6.2

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 6.4 — Final Regression Pass and PR Merge Readiness Check

**Description**: Run the full test suite, fix any regressions, update CLAUDE.md if needed, and confirm all acceptance criteria from the goal description are met.

**Subtasks**:
1. Run `make test-daemon` — fix any failures
2. Run `make test-web` — fix any failures
3. Run `bun run check` (lint + typecheck + knip) — fix any dead exports or type errors
4. Run `make run-e2e TEST=tests/features/short-id-display.e2e.ts` — confirm e2e passes
5. Review the goal's acceptance criteria checklist and confirm each item is satisfied:
   - Task and goal IDs display as short IDs in UI ✓ (**session IDs are out of scope** — see overview)
   - Both UUID and short ID accepted as input in all APIs ✓
   - Worktree paths significantly shorter ✓
   - Existing UUID-based links work ✓
   - No DB migration required (only additive schema changes) ✓
   - Multi-tenant isolation verified ✓
   - Unit tests for short ID computation and parsing ✓
6. If any item is missing, file a follow-up task or fix it in this PR

**Acceptance Criteria**:
- All acceptance criteria from the goal description are checked off
- `make test-daemon` passes
- `make test-web` passes
- `bun run check` passes
- E2e test passes

**Depends on**: All previous tasks complete

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.
