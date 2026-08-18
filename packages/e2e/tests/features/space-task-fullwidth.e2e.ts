import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot, getModal } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
  deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Task Full-Width View', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'task-fullwidth');
    const spaceName = `E2E Full-Width Task Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    await deleteSpaceWorkflowsViaRpc(page, spaceId);

    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
  });

  test('clicking a task opens full-width task pane and hides overview surface', async ({
    page,
  }) => {
    const taskTitle = `Full-Width Task ${Date.now()}`;

    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const dialog = getModal(page);
    await expect(dialog).toBeVisible({ timeout: 3000 });

    await dialog.getByPlaceholder('e.g., Implement authentication module').fill(taskTitle);
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();

    await page.getByText(taskTitle, { exact: true }).first().click();

    await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    await expect(page.getByTestId('space-overview-view')).not.toBeAttached({ timeout: 3000 });
  });

  test('back button in task view returns to the tabbed dashboard', async ({ page }) => {
    const taskTitle = `Back Button Task ${Date.now()}`;

    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const dialog = getModal(page);
    await dialog.getByPlaceholder('e.g., Implement authentication module').fill(taskTitle);
    await dialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    await page.getByText(taskTitle, { exact: true }).first().click();
    await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    await page.locator('[data-testid="task-back-button"]').click();

    await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
      timeout: 3000,
    });

    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  test('task pane is not attached before any task is selected', async ({ page }) => {
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });
});
