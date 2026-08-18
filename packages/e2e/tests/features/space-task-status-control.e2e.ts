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

  test('blocked task shows blocked reason on the Review tab of SpaceTasks', async ({ page }) => {
    await updateSpaceTaskStatusViaRpc(page, spaceId, taskId, 'blocked', BLOCKED_REASON);

    await page.goto(`/space/${spaceId}`);
    await expect(page.getByTestId('space-detail-tasks')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('space-detail-tasks').click();
    await page.waitForURL(`/space/${spaceId}/tasks`, { timeout: 5000 });
    await expect(page.locator(TASKS_VIEW)).toBeVisible({ timeout: 10000 });

    const tasksView = page.locator(TASKS_VIEW);
    const actionTab = tasksView.getByRole('button', { name: 'Action' });
    await expect(actionTab).toBeVisible({ timeout: 10000 });
    await actionTab.click();

    await expect(tasksView.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    const blockedReason = tasksView.getByTestId('task-blocked-reason');
    await expect(blockedReason).toBeVisible({ timeout: 5000 });
    await expect(blockedReason).toContainText(BLOCKED_REASON);
  });

  test('blocked task pane shows blocked banner, Resume changes status to In Progress', async ({
    page,
  }) => {
    await updateSpaceTaskStatusViaRpc(page, spaceId, taskId, 'blocked', BLOCKED_REASON);

    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 5000 });

    await expect(page.getByTestId('task-status-label')).toContainText('Blocked', { timeout: 5000 });

    const banner = page.getByTestId('task-blocked-banner');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('Blocked');
    await expect(banner).toContainText(BLOCKED_REASON);

    const resumeBtn = page.getByTestId('task-action-in_progress');
    await expect(resumeBtn).toBeVisible({ timeout: 3000 });
    await expect(resumeBtn).toHaveText('Resume');

    await resumeBtn.click();

    await expect(page.getByTestId('task-status-label')).toContainText('In Progress', {
      timeout: 5000,
    });

    await expect(banner).not.toBeVisible({ timeout: 3000 });
  });

  test('done task pane shows Reopen action, clicking it changes status to In Progress', async ({
    page,
  }) => {
    await updateSpaceTaskStatusViaRpc(page, spaceId, taskId, 'done');

    await page.goto(`/space/${spaceId}`);
    await expect(page.getByTestId('space-detail-tasks')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('space-detail-tasks').click();
    await page.waitForURL(`/space/${spaceId}/tasks`, { timeout: 5000 });
    await expect(page.locator(TASKS_VIEW)).toBeVisible({ timeout: 10000 });

    const tasksView = page.locator(TASKS_VIEW);
    const completedTab = tasksView.getByRole('button', { name: 'Completed' });
    await expect(completedTab).toBeVisible({ timeout: 10000 });
    await completedTab.click();

    await expect(tasksView.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    await tasksView.getByText(taskTitle, { exact: true }).first().click();
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 5000 });

    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    await expect(page.getByTestId('task-status-label')).toContainText('Done', { timeout: 5000 });

    const reopenBtn = page.getByTestId('task-action-in_progress');
    await expect(reopenBtn).toBeVisible({ timeout: 3000 });
    await expect(reopenBtn).toHaveText('Reopen');

    await reopenBtn.click();

    await expect(page.getByTestId('task-status-label')).toContainText('In Progress', {
      timeout: 5000,
    });
  });
});
