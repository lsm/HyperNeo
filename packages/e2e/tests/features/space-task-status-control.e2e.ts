/**
 * Space Task Blocked Status & Manual Status Control E2E Tests
 *
 * Verifies:
 * - Blocked tasks show the blocked reason on the SpaceOverview "Review" tab
 * - Opening a blocked task shows the blocked reason banner in SpaceTaskPane
 * - User can click "Resume" to transition blocked → in_progress via the UI
 * - Opening a done task shows the "Reopen" action
 * - User can click "Reopen" to transition done → in_progress via the UI
 *
 * Setup: creates a space + task via RPC in beforeEach, sets status via RPC (infrastructure).
 * Cleanup: deletes the space via RPC in afterEach (infrastructure).
 *
 * E2E rules:
 * - RPC calls only in beforeEach/afterEach (infrastructure).
 * - All test actions go through the UI: clicks, navigation, assertions on visible DOM.
 * - No internal state access during test assertions.
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  createSpaceTaskViaRpc,
  updateSpaceTaskStatusViaRpc,
  deleteSpaceViaRpc,
  deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };
const TASKS_VIEW = '[data-testid="space-tasks-view"]';
const BLOCKED_REASON = 'Need more information about the API endpoint design before proceeding.';

test.describe('Space Task Blocked Status & Manual Status Control', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let taskId = '';
  let taskTitle = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'task-status');
    const spaceName = `E2E Task Status ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);

    // Delete seeded built-in workflows so SpaceOverview is visible (not hidden by WorkflowCanvas)
    await deleteSpaceWorkflowsViaRpc(page, spaceId);

    taskTitle = `Status Control Task ${Date.now()}`;
    taskId = await createSpaceTaskViaRpc(page, spaceId, taskTitle);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
      taskId = '';
      taskTitle = '';
    }
  });

  // ---------------------------------------------------------------------------
  // Scenario 1: Blocked indicator on SpaceOverview "Review" tab
  // ---------------------------------------------------------------------------

  test('blocked task shows blocked reason on the Review tab of SpaceTasks', async ({ page }) => {
    // Set task to blocked with a reason (RPC setup — not a UI action)
    await updateSpaceTaskStatusViaRpc(page, spaceId, taskId, 'blocked', BLOCKED_REASON);

    // Navigate to space overview first, then SPA-navigate to tasks
    // (direct URL to /tasks can race with space data loading)
    await page.goto(`/space/${spaceId}`);
    await expect(page.getByTestId('space-detail-tasks')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('space-detail-tasks').click();
    await page.waitForURL(`/space/${spaceId}/tasks`, { timeout: 5000 });
    await expect(page.locator(TASKS_VIEW)).toBeVisible({ timeout: 10000 });

    // Click the "Action" tab which shows blocked + review tasks
    const tasksView = page.locator(TASKS_VIEW);
    const actionTab = tasksView.getByRole('button', { name: 'Action' });
    await expect(actionTab).toBeVisible({ timeout: 10000 });
    await actionTab.click();

    // The task title should appear in the Action group
    await expect(tasksView.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    // The blocked reason should appear as amber text below the task title
    const blockedReason = tasksView.getByTestId('task-blocked-reason');
    await expect(blockedReason).toBeVisible({ timeout: 5000 });
    await expect(blockedReason).toContainText(BLOCKED_REASON);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Blocked reason banner in task pane + Resume → in_progress
  // ---------------------------------------------------------------------------

  test('blocked task pane shows blocked banner, Resume changes status to In Progress', async ({
    page,
  }) => {
    // Set task to blocked with a reason (RPC setup)
    await updateSpaceTaskStatusViaRpc(page, spaceId, taskId, 'blocked', BLOCKED_REASON);

    // Navigate directly to the task pane URL
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Task pane should be visible
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 5000 });

    // Status label shows "Blocked"
    await expect(page.getByTestId('task-status-label')).toContainText('Blocked', { timeout: 5000 });

    // Blocked reason banner should be visible with the reason text
    const banner = page.getByTestId('task-blocked-banner');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('Blocked');
    await expect(banner).toContainText(BLOCKED_REASON);

    // "Resume" action button should be available (blocked → in_progress)
    const resumeBtn = page.getByTestId('task-action-in_progress');
    await expect(resumeBtn).toBeVisible({ timeout: 3000 });
    await expect(resumeBtn).toHaveText('Resume');

    // Click "Resume" to transition the task back to in_progress
    await resumeBtn.click();

    // Status label should update to "In Progress"
    await expect(page.getByTestId('task-status-label')).toContainText('In Progress', {
      timeout: 5000,
    });

    // Blocked banner should no longer be visible
    await expect(banner).not.toBeVisible({ timeout: 3000 });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Done task pane shows "Reopen" action → in_progress
  // ---------------------------------------------------------------------------

  test('done task pane shows Reopen action, clicking it changes status to In Progress', async ({
    page,
  }) => {
    // Set task to done (RPC setup — open → done is a valid transition)
    await updateSpaceTaskStatusViaRpc(page, spaceId, taskId, 'done');

    // Navigate to space overview first, then SPA-navigate to tasks
    // (direct URL to /tasks can race with space data loading)
    await page.goto(`/space/${spaceId}`);
    await expect(page.getByTestId('space-detail-tasks')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('space-detail-tasks').click();
    await page.waitForURL(`/space/${spaceId}/tasks`, { timeout: 5000 });
    await expect(page.locator(TASKS_VIEW)).toBeVisible({ timeout: 10000 });

    // Click the "Completed" tab (shows done + cancelled tasks)
    const tasksView = page.locator(TASKS_VIEW);
    const completedTab = tasksView.getByRole('button', { name: 'Completed' });
    await expect(completedTab).toBeVisible({ timeout: 10000 });
    await completedTab.click();

    // Task title should appear under the Completed tab
    await expect(tasksView.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    // Click the task to open the task pane
    await tasksView.getByText(taskTitle, { exact: true }).first().click();
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 5000 });

    // Task pane should be visible
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    // Status label shows "Done"
    await expect(page.getByTestId('task-status-label')).toContainText('Done', { timeout: 5000 });

    // "Reopen" action button should be available (done → in_progress)
    const reopenBtn = page.getByTestId('task-action-in_progress');
    await expect(reopenBtn).toBeVisible({ timeout: 3000 });
    await expect(reopenBtn).toHaveText('Reopen');

    // Click "Reopen" to transition the task back to in_progress
    await reopenBtn.click();

    // Status label should update to "In Progress"
    await expect(page.getByTestId('task-status-label')).toContainText('In Progress', {
      timeout: 5000,
    });
  });
});
