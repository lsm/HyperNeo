# Fix Goal Lifecycle: Reset, Invalidate Stale Planning, Fix isTerminal

## Summary

When a goal's description is updated mid-planning, the planner keeps working on the old description. After cancelling the planning task, the goal gets stuck in `needs_human` with stale state (`linkedTaskIds` referencing archived tasks, `planning_attempts` blocking replanning). This plan addresses four issues:

1. Missing `archived` in both `isTerminal()` checks in `room-runtime.ts`
2. No way to reset a goal to its initial state without archiving
3. Goal description updates do not invalidate in-progress planning
4. `planning_attempts` is not writable via `update_goal`

## Approach

All four fixes target three existing files with well-established patterns. A new `reset_goal` MCP tool follows the same two-layer pattern (handler + schema) as existing tools. The `isTerminal` fixes are one-line changes. The invalidation hook adds logic to the existing `update_goal` handler. Tests cover all changes using existing in-memory DB test patterns.

### Key architectural decisions

- **No explicit `scheduleTick()` calls**: `scheduleTick()` is a private method on `RoomRuntime`. The tick is already triggered implicitly through the task cancellation event pipeline: `cancelTask()` → emits `room.task.update` → `onTaskStatusChanged()` → `scheduleTick()`. For fallback paths using `taskManager.cancelTaskCascade()`, emitting `room.task.update` events achieves the same result.
- **Use `runtime.onGoalCreated()` for tick trigger after reset**: `goal.updated` events are not subscribed to by `room-runtime-service.ts`. After a goal reset, call `runtime.onGoalCreated(goalId)` (which is public and internally calls `scheduleTick()`) to ensure the runtime picks up the reset goal for fresh planning. This reuses the existing pattern visible at `room-runtime-service.ts` line 837.
- **Race window on invalidation is acceptable**: The invalidation logic in `update_goal` runs after `patchGoal()`. Between the patch and cancellation, the planning session could briefly read the updated description. This race is acceptable since the task will be cancelled shortly after regardless, and the sequential tick loop prevents concurrent re-planning.

---

## Task 1: Fix both `isTerminal()` checks and add `resetGoal()` to GoalManager

**Description:** Fix both `isTerminal` helpers in `room-runtime.ts` to include `archived`, and add a `resetGoal()` method to `GoalManager` that clears linked tasks, resets all counters (including `replanCount`), and sets status to `active`.

**Agent type:** coder

**Depends on:** (none)

**Subtasks:**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/runtime/room-runtime.ts`, locate `getNextGoalForPlanning()` around line 3543. Change the `isTerminal` lambda from:
   ```ts
   const isTerminal = (status: string) =>
       status === 'needs_attention' || status === 'cancelled';
   ```
   to:
   ```ts
   const isTerminal = (status: string) =>
       status === 'needs_attention' || status === 'cancelled' || status === 'archived';
   ```
3. In the same file, locate `_doTickRecurringMissions()` around line 3336. Change the `isTerminal` lambda from:
   ```ts
   const isTerminal = (status: string) =>
       status === 'completed' || status === 'needs_attention' || status === 'cancelled';
   ```
   to:
   ```ts
   const isTerminal = (status: string) =>
       status === 'completed' || status === 'needs_attention' || status === 'cancelled' || status === 'archived';
   ```
   Without this, if tasks in a recurring execution are archived, the execution would never be marked complete and would hang indefinitely.
4. In `packages/daemon/src/lib/room/managers/goal-manager.ts`, add a new `resetGoal(goalId: string)` method that:
   - Fetches the goal (throw if not found)
   - Calls `this.goalRepo.updateGoal(goalId, { linkedTaskIds: [], planning_attempts: 0, consecutiveFailures: 0, replanCount: 0, status: 'active' })`
   - Returns the updated `RoomGoal`
   - Note: `replanCount` must be reset along with other counters to avoid stale replan count in the next planning cycle
5. Add unit tests in `packages/daemon/tests/unit/room/goal-manager.test.ts`:
   - Test `resetGoal` clears `linkedTaskIds`, resets `planning_attempts` to 0, resets `consecutiveFailures` to 0, resets `replanCount` to 0, and sets status to `active`
   - Test `resetGoal` works when goal is in `needs_human` status (resets to `active`)
   - Test `resetGoal` throws for non-existent goal ID
6. Add a unit test in `packages/daemon/tests/unit/room/mission-system-edge-cases.test.ts` verifying that when all linked tasks are `archived`, the goal is eligible for replanning (exercises the `isTerminal` fix in `getNextGoalForPlanning`).
7. Add a unit test verifying that in `_doTickRecurringMissions`, archived tasks are treated as terminal (so recurring executions can complete when tasks are archived).
8. Run `make test-daemon` to verify all tests pass.
9. Run `bun run check` to verify lint, typecheck, and knip pass.
10. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Both `isTerminal` lambdas include `archived` status
- `GoalManager.resetGoal()` exists and resets all five fields (`linkedTaskIds`, `planning_attempts`, `consecutiveFailures`, `replanCount`, `status`)
- Unit tests cover the reset method (including `needs_human` → `active` transition), both isTerminal fixes, and error case
- All daemon tests pass; lint and typecheck pass

---

## Task 2: Add `reset_goal` MCP tool and expose `planning_attempts` in `update_goal`

**Description:** Add a new `reset_goal` MCP tool to `room-agent-tools.ts` and update `update_goal` to accept `planning_attempts` as an optional field. The `reset_goal` tool cancels all in-progress linked tasks via the runtime and then calls `GoalManager.resetGoal()`.

**Agent type:** coder

**Depends on:** Task 1

**Subtasks:**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`, in `createRoomAgentToolHandlers()`, add a new `reset_goal` handler:
   - Takes `{ goal_id: string }` as input
   - Fetches the goal; return error if not found
   - Iterates `goal.linkedTaskIds`, for each task that is in a non-terminal status (`pending`, `in_progress`, `draft`, `review`, `rate_limited`, `usage_limited`):
     - If `runtimeService` is available and returns a runtime, call `runtime.cancelTask(taskId)`
     - Otherwise fall back to `taskManager.cancelTaskCascade(taskId)` and emit `room.task.update` event via `daemonHub` (so the cancellation pipeline triggers a tick)
   - Calls `goalManager.resetGoal(goal_id)`
   - If `runtimeService` is available and returns a runtime, call `runtime.onGoalCreated(goal_id)` to trigger a tick for fresh planning (do NOT call `runtime.scheduleTick()` — it is private)
   - Returns success with the updated goal
3. Register `reset_goal` in `createRoomAgentMcpServer()` with a Zod schema:
   ```ts
   tool(
     'reset_goal',
     'Reset a goal to its initial state: cancels all linked tasks, clears linkedTaskIds, resets planning_attempts, consecutiveFailures, and replanCount to 0, and sets status to active. Use when a goal is stuck or needs a fresh start.',
     { goal_id: z.string().describe('ID of the goal to reset') },
     (args) => handlers.reset_goal(args)
   )
   ```
4. Do NOT add `reset_goal` to `createLeaderContextMcpServer()`. Update the tool list comment at top of file to include `reset_goal`.
5. In `update_goal` handler, add `planning_attempts` as an optional field:
   - Add `planning_attempts?: number` to the handler args type
   - Add `planning_attempts` to the "no fields provided" guard check
   - Add `planning_attempts` to the `hasPatchFields` check
   - Add `if (args.planning_attempts !== undefined) patch.planning_attempts = args.planning_attempts;` in the patch-building block
6. In `update_goal` schema registration, add:
   ```ts
   planning_attempts: z.number().int().min(0).optional().describe('Reset or set the planning attempts counter')
   ```
7. Add unit tests in a new file `packages/daemon/tests/unit/room/room-agent-tools-goal.test.ts`:
   - Mock `GoalManager`, `TaskManager`, `SessionGroupRepository`, and optionally `DaemonHub`/`RoomRuntime`
   - Test `reset_goal` successfully cancels linked tasks and resets the goal
   - Test `reset_goal` returns error for non-existent goal
   - Test `reset_goal` calls `runtime.onGoalCreated()` after reset (when runtime is available)
   - Test `update_goal` with `planning_attempts` field persists the value
   - **Negative test**: Verify `reset_goal` is NOT registered in `createLeaderContextMcpServer()` — inspect the tool list returned by the leader MCP server and assert `reset_goal` is absent
8. Run `make test-daemon` to verify all tests pass.
9. Run `bun run check` to verify lint, typecheck, and knip pass.
10. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `reset_goal` MCP tool is registered in `createRoomAgentMcpServer` but NOT in `createLeaderContextMcpServer`
- `reset_goal` cancels in-progress linked tasks before resetting
- `reset_goal` triggers a runtime tick via `runtime.onGoalCreated()` (not `scheduleTick()`) after reset
- For fallback path (no runtime), `room.task.update` events are emitted to trigger tick via event pipeline
- `update_goal` accepts and persists `planning_attempts`
- Negative test confirms `reset_goal` is absent from leader MCP server
- All daemon tests pass; lint and typecheck pass

---

## Task 3: Goal description update invalidates in-progress planning

**Description:** When `update_goal` changes `title` or `description` and the goal has an in-progress planning task, auto-cancel that planning task, reset `planning_attempts` to 0, and if the goal is in `needs_human` status, transition it back to `active` so it becomes eligible for replanning.

**Agent type:** coder

**Depends on:** Task 1, Task 2

**Subtasks:**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/lib/room/tools/room-agent-tools.ts`, in the `update_goal` handler, after the patch is applied (after `goalManager.patchGoal()`), add invalidation logic:
   - Check if `args.title !== undefined || args.description !== undefined`
   - If so, fetch the current goal and its `linkedTaskIds`; find tasks where `taskType === 'planning'` and status is non-terminal (not `completed`, `cancelled`, `archived`)
   - For each such planning task:
     - If `runtimeService` is available, call `runtime.cancelTask(taskId)`
     - Otherwise fall back to `taskManager.cancelTaskCascade(taskId)` and emit `room.task.update` event via `daemonHub`
   - Reset `planning_attempts` to 0 via `goalManager.patchGoal(goalId, { planning_attempts: 0 })`
   - **Status recovery**: If the goal's current status is `needs_human`, also update it to `active` via `goalManager.updateGoalStatus(goalId, 'active')`. This is critical because `getNextGoalForPlanning()` only iterates `active` goals (line 3500: `listGoals('active')`), so a `needs_human` goal with reset `planning_attempts` would still be unreachable for replanning without a status change.
   - If `runtimeService` is available and returns a runtime, call `runtime.onGoalCreated(goalId)` to trigger a tick for fresh planning
3. Add unit tests in `packages/daemon/tests/unit/room/room-agent-tools-goal.test.ts`:
   - Test that updating `title` cancels in-progress planning tasks and resets `planning_attempts`
   - Test that updating `description` cancels in-progress planning tasks and resets `planning_attempts`
   - Test that updating only `priority` does NOT cancel planning tasks
   - Test that when no planning tasks are in progress, no cancellation occurs
   - Test that a `needs_human` goal transitions to `active` when title/description is updated (the key scenario from the bug report)
   - Test that an `active` goal stays `active` (status not changed if already active)
4. Run `make test-daemon` to verify all tests pass.
5. Run `bun run check` to verify lint, typecheck, and knip pass.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Changing `title` or `description` via `update_goal` auto-cancels in-progress planning tasks
- `planning_attempts` is reset to 0 after invalidation
- A `needs_human` goal is transitioned to `active` when title/description changes (making it eligible for replanning)
- A tick is triggered via `runtime.onGoalCreated()` after invalidation (not `scheduleTick()`)
- Non-title/description updates do NOT trigger invalidation
- Unit tests cover all scenarios including `needs_human` → `active` transition
- All daemon tests pass; lint and typecheck pass

---

## Task 4: Online integration test for goal lifecycle reset

**Description:** Add an online test that exercises the full goal lifecycle: create goal, set up planning state, update description (triggering invalidation), and reset goal. This test verifies the DB-level state changes via RPC assertions, not actual planning session behavior.

**Agent type:** coder

**Depends on:** Task 1, Task 2, Task 3

**Subtasks:**

1. Run `bun install` at the worktree root.
2. Identify the existing online test pattern in `packages/daemon/tests/online/` for room/goal-related tests.
3. Create a new online test file `packages/daemon/tests/online/room/goal-lifecycle-reset.test.ts` that:
   - Sets up a daemon server with a room using the existing test helpers
   - **Test: reset_goal clears all state**:
     - Creates a goal via RPC
     - Manually sets up stale state: add `linkedTaskIds`, increment `planning_attempts`, set `consecutiveFailures` > 0 (via direct goal update RPC or goal manager calls)
     - Calls `reset_goal` MCP tool
     - Asserts via `goal.get` RPC: `linkedTaskIds` is empty, `planning_attempts === 0`, `consecutiveFailures === 0`, `status === 'active'`
   - **Test: description update resets planning_attempts**:
     - Creates a goal via RPC
     - Sets `planning_attempts` to 3 via `update_goal` with `planning_attempts: 3`
     - Updates `description` via `update_goal`
     - Asserts via `goal.get` RPC: `planning_attempts === 0` (invalidation occurred)
   - **Test: planning_attempts is writable via update_goal**:
     - Creates a goal, updates with `planning_attempts: 5`
     - Asserts via `goal.get` RPC: `planning_attempts === 5`
   - **Test: description update transitions needs_human to active**:
     - Creates a goal, transitions it to `needs_human` status
     - Updates `description` via `update_goal`
     - Asserts via `goal.get` RPC: `status === 'active'`
4. Run the new test with `cd packages/daemon && HYPERNEO_USE_DEV_PROXY=1 bun test ./tests/online/room/goal-lifecycle-reset.test.ts` to verify it passes.
5. Run `bun run check` to verify lint, typecheck, and knip pass.
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Online test exercises reset, invalidation, `planning_attempts` write, and status recovery flows
- Each test case asserts specific DB-level state via `goal.get` RPC (not planning session behavior)
- Test passes with `HYPERNEO_USE_DEV_PROXY=1`
- All checks pass
