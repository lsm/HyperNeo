# Fix E2E Test Failures on Dev Branch CI

## Goal

Fix four failing E2E test suites on the `dev` branch CI (run ID `23382023181`):

1. `features-task-actions-dropdown` -- 9/10 tests fail
2. `features-space-creation` -- 1/7 tests fail
3. `features-visual-workflow-editor` -- 6/6 tests fail
4. `features-worktree-isolation` -- 1/5 tests fail (LLM test)

## Approach

The failures group into four root causes. Each task below addresses one root cause. All PRs target `dev`.

---

## Task 1: Fix task-actions-dropdown E2E tests -- update selectors to match actual UI

**Type:** coder

**Description:**
The `task-actions-dropdown.e2e.ts` tests were written expecting a three-dot dropdown menu with `data-testid="task-options-menu"`, but the actual `TaskView.tsx` uses inline action buttons:
- `data-testid="task-cancel-button"` (Cancel button, visible for pending/in_progress/review tasks)
- `data-testid="task-complete-button"` (Complete button, visible for in_progress tasks; hidden for review status per line 950 condition `task.status !== 'review'`)

Additionally, some tests transition tasks to `in_progress` which triggers worktree creation. In CI, the workspace is a temp directory (not a git repo), so worktree creation fails with "Worktree creation failed -- task requires isolation". The tests that need `in_progress` status should use `task.setStatus` RPC directly (which is already done in the test helper `createRoomAndTask`), and the test assertions should not depend on a worktree-spawned session.

**Key files:**
- `packages/e2e/tests/features/task-actions-dropdown.e2e.ts` -- the failing test file
- `packages/web/src/components/room/TaskView.tsx` -- the actual UI (lines ~938-968 for action buttons, lines ~500-630 for confirmation modals)

**Subtasks:**
1. Read the current TaskView.tsx to understand the actual UI pattern (inline buttons, not dropdown menu).
2. Rewrite ALL tests that reference `task-options-menu` to use `task-cancel-button` and `task-complete-button`. Use `not.toBeAttached()` (not `not.toBeVisible()`) when asserting an element should not be in the DOM — `not.toBeVisible()` passes vacuously for missing elements and would not catch real regressions:
   - "shows task options menu for pending task (cancel only)" -- assert `task-cancel-button` is attached and visible, `task-complete-button` is `not.toBeAttached()`.
   - "shows task options menu for in_progress task (complete + cancel)" -- assert both buttons visible.
   - "does NOT show task options menu for completed task" -- **DO NOT keep as-is.** This test still uses `task-options-menu` which doesn't exist. Rewrite to assert that both `task-cancel-button` and `task-complete-button` are `not.toBeAttached()` for a completed task. This validates real UI state instead of vacuously passing on a nonexistent element.
   - "opens dropdown and shows Cancel Task item" -- replace dropdown menu interaction with direct click on `task-cancel-button`.
   - "shows Mark as Complete for in_progress task" -- replace dropdown interaction with asserting `task-complete-button` visible.
   - "opens cancel confirmation dialog on Cancel Task click" -- click `task-cancel-button` directly instead of opening dropdown.
   - "opens complete confirmation dialog on Mark as Complete click" -- click `task-complete-button` directly.
   - "can dismiss cancel dialog with Keep Task button" -- click `task-cancel-button` directly, rest stays same.
   - "cancels task and navigates away on confirmation" -- click `task-cancel-button` directly, confirm, check navigation.
   - "completes task and navigates away on confirmation" -- click `task-complete-button` directly, confirm, check navigation.
3. Update the test file's JSDoc header (lines 3-8) which describes "Three-dot dropdown menu replaces the old cancel button" -- this description is now incorrect. Update to describe inline action buttons.
4. For tests that wait for task status to appear in the UI after creating a task with `in_progress` status: ensure the test navigates to the task page AFTER the status transition is complete (the helper already does this via RPC `task.setStatus`). The page should render the correct buttons based on the task's current status from the database, not from a live worktree session.
5. Run the test locally: `make run-e2e TEST=tests/features/task-actions-dropdown.e2e.ts`.
6. Verify all tests pass.

**Acceptance Criteria:**
- All 10 tests in `task-actions-dropdown.e2e.ts` pass locally.
- Tests use the actual UI selectors (`task-cancel-button`, `task-complete-button`, `cancel-task-confirm`, `complete-task-confirm`).
- No tests rely on `data-testid="task-options-menu"` (which does not exist).
- Test 3 ("completed task") asserts real selectors with `not.toBeAttached()`, not a vacuous check on a nonexistent element.
- JSDoc header is updated to describe the actual inline button pattern.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None

---

## Task 2: Fix space-creation E2E test -- update assertion to match actual space layout

**Type:** coder

**Description:**
The test "creates space and shows 3-column layout" in `space-creation.e2e.ts` (line 122) expects to see `SpaceNavPanel` content ("No runs or tasks yet") after space creation. However, `SpaceNavPanel` is not used in the actual `SpaceIsland` component. The space view uses a tabbed layout (Dashboard, Agents, Workflows, Settings) without a left nav panel showing runs/tasks.

After creating a space, the user is navigated to `/space/<id>` where `SpaceIsland` renders with the Dashboard tab active, showing the `SpaceDashboard` component which has "Quick Actions", "Start Workflow Run", and "Create Task" text.

**Key files:**
- `packages/e2e/tests/features/space-creation.e2e.ts` -- the failing test (line 122-159)
- `packages/web/src/islands/SpaceIsland.tsx` -- actual space view component (tabbed layout)
- `packages/web/src/components/space/SpaceDashboard.tsx` -- Dashboard tab content
- `packages/web/src/components/space/SpaceNavPanel.tsx` -- unused component (not imported by SpaceIsland)

**Subtasks:**
1. Read SpaceIsland.tsx and SpaceDashboard.tsx to understand what is actually rendered when a space is loaded.
2. Update the test assertions in "creates space and shows 3-column layout" to match the actual UI:
   - Remove assertion for "No runs or tasks yet" (from SpaceNavPanel, not rendered).
   - Keep or adjust assertions for "Quick Actions", "Start Workflow Run", "Create Task" -- these are in SpaceDashboard and should be visible on the Dashboard tab.
3. Rename the test from "creates space and shows 3-column layout" to "creates space and shows tabbed dashboard layout" to reflect the actual tabbed UI.
4. Run the test locally: `make run-e2e TEST=tests/features/space-creation.e2e.ts`.
5. Verify all tests pass.

**Acceptance Criteria:**
- All tests in `space-creation.e2e.ts` pass locally.
- Test assertions match the actual space layout (tabbed view with Dashboard).
- Test name reflects the actual tabbed layout, not "3-column".
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None

---

## Task 3: Fix visual-workflow-editor E2E tests -- fix navigateToSpace loading race condition

**Type:** coder

**Description:**
All 6 tests in `visual-workflow-editor.e2e.ts` fail with a 60-second timeout waiting for `text=Workflows` to appear on the page after navigating to `/space/<id>`. One test also fails with "No agents found in space" when calling `getDefaultAgentId()`.

**Primary root cause:** The `navigateToSpace()` helper navigates via `page.goto()` which triggers a full page load, but only waits for the URL to match — it does NOT wait for the SpaceIsland component to finish loading. `SpaceIsland` calls `spaceStore.selectSpace(spaceId)` on mount (line 66), which calls the `space.overview` RPC. Until this resolves, the component shows a loading spinner (line 108) and the tab bar (Dashboard, Agents, Workflows, Settings) is not rendered. The test then immediately tries to click `text=Workflows` which doesn't exist yet, causing the 60-second timeout.

**Fix approach:** Update the `navigateToSpace()` helper to wait for the space tab bar to appear (e.g., wait for `text=Dashboard` to be visible) before returning. This ensures subsequent test code can reliably interact with space tabs.

**Secondary issue — "No agents found":** The `getDefaultAgentId()` helper (line 118) calls `spaceAgent.list` and throws if no agents are returned. The `seedPresetAgents` function has no git dependency (it only calls `agentManager.create` with name/role/description/tools), so this is a timing issue — `spaceAgent.list` may be called before seeding completes. The fix for the primary issue (waiting for space to fully load) should also resolve this timing problem.

**Key files:**
- `packages/e2e/tests/features/visual-workflow-editor.e2e.ts` -- failing tests
- `packages/e2e/tests/helpers/` -- test helpers including `navigateToSpace`
- `packages/web/src/islands/SpaceIsland.tsx` -- space view component (line 108: loading spinner, line 66: selectSpace call)
- `packages/web/src/lib/space-store.ts` -- space store with `selectSpace`/`doSelect`/`startSubscriptions`
- `packages/daemon/src/lib/agents/seed-agents.ts` -- agent seeding on space creation (no git dependency)

**Subtasks:**
1. Run the visual-workflow-editor test locally to reproduce the failure: `make run-e2e TEST=tests/features/visual-workflow-editor.e2e.ts`.
2. Find the `navigateToSpace()` helper and update it to wait for a space-specific element (e.g., `text=Dashboard` tab) to be visible before returning. This ensures the SpaceIsland has finished loading.
3. `navigateToSpace` is NOT a shared helper — it is a local function duplicated independently in both `visual-workflow-editor.e2e.ts` (line 71) and `space-workflow-rules.e2e.ts` (line 72). Both copies have the identical missing-wait bug. Apply the same fix to BOTH files to prevent a repeat failure in `space-workflow-rules` tests.
4. For the "No agents found" error in test 2 (`getDefaultAgentId`): verify this is resolved by the loading wait fix. If not, add a retry or explicit wait for agents to be seeded before calling `spaceAgent.list`.
5. Run the test locally and verify all 6 tests pass: `make run-e2e TEST=tests/features/visual-workflow-editor.e2e.ts`.

**Acceptance Criteria:**
- All 6 tests in `visual-workflow-editor.e2e.ts` pass locally.
- The `navigateToSpace()` helper waits for the space tab bar to appear before returning (no fixed `waitForTimeout` — use proper Playwright waits).
- The "No agents found" error is resolved.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None

---

## Task 4: Fix worktree-isolation E2E test -- replace fixed sleep with proper Playwright wait

**Type:** coder

**Description:**
The test "should cleanup worktree when session is deleted" in `worktree-isolation.e2e.ts` (line 84) fails because after deleting a session and waiting 2 seconds via `waitForTimeout(2000)`, the URL still contains the deleted session ID.

**Root cause:** Navigation after session deletion IS already implemented. In `useSessionActions.ts` (lines 62-78), `handleDeleteSession` sets `currentSessionIdSignal.value = null` (via setTimeout), which triggers an effect in `App.tsx` (lines 82-122) that navigates to the home page. The navigation works, but may not complete within the fixed 2-second `waitForTimeout`. The test uses `page.waitForTimeout(2000)` (a fixed sleep) instead of a proper Playwright assertion that auto-retries.

**Fix approach:** Replace the `page.waitForTimeout(2000)` + manual URL assertion with `await expect(page).not.toHaveURL(/sessionId/)` which is a Playwright auto-retrying assertion with a configurable timeout. This is the correct Playwright pattern for waiting on URL changes. Do NOT add redundant navigation code to `useSessionActions.ts` — the navigation already works via the signal → effect chain.

**Key files:**
- `packages/e2e/tests/features/worktree-isolation.e2e.ts` -- failing test (line 84-121)
- `packages/web/src/hooks/useSessionActions.ts` -- session deletion handler (lines 62-78, sets `currentSessionIdSignal.value = null`)
- `packages/web/src/App.tsx` -- effect that navigates home when `currentSessionIdSignal` becomes null (lines 82-122)
- `packages/web/src/lib/router.ts` -- routing logic including `navigateHome()`

**Subtasks:**
1. Read `useSessionActions.ts` and `App.tsx` to confirm the existing navigation mechanism (signal → effect → navigateHome).
2. In the test, replace the `page.waitForTimeout(2000)` followed by manual URL check with:
   ```typescript
   await expect(page).not.toHaveURL(new RegExp(sessionId), { timeout: 10000 });
   ```
   This auto-retries until the URL no longer contains the session ID, with a generous timeout.
3. Run the test locally: `make run-e2e TEST=tests/features/worktree-isolation.e2e.ts`. Note: this is an LLM test requiring devproxy or real API credentials.
4. Verify the test passes.

**Acceptance Criteria:**
- The "should cleanup worktree when session is deleted" test passes.
- After session deletion, the URL no longer contains the deleted session's ID.
- The test uses Playwright's auto-retrying `expect(page).not.toHaveURL()` instead of a fixed `waitForTimeout` sleep.
- No redundant navigation code is added to the source — the existing signal → effect chain is preserved.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Dependencies:** None
