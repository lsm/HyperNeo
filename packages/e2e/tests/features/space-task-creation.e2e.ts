import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot, getModal } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Task Creation', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'task-creation');
    const spaceName = `E2E Task Creation Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);

    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.getByTestId('space-overview-view')).toBeVisible({
      timeout: 5000,
    });
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
  });

  test('Create Task button opens SpaceCreateTaskDialog', async ({ page }) => {
    const createTaskBtn = page.getByRole('button', { name: 'Create Task' }).first();
    await expect(createTaskBtn).toBeVisible({ timeout: 5000 });

    await createTaskBtn.click();

    const dialog = getModal(page);
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog.getByRole('heading', { name: 'Create Task' })).toBeVisible();
  });

  test('submitting the Create Task form creates a task in Recent Activity', async ({ page }) => {
    const taskTitle = `E2E Task ${Date.now()}`;

    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const titleInput = page.getByPlaceholder('e.g., Implement authentication module');
    await expect(titleInput).toBeVisible({ timeout: 3000 });
    await titleInput.fill(taskTitle);

    const dialog = getModal(page);
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    await expect(page.getByText(`Task "${taskTitle}" created`)).toBeVisible({ timeout: 5000 });

    await expect(getModal(page)).not.toBeVisible({ timeout: 3000 });

    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('Cancel dismisses the dialog without creating a task', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const dialog = getModal(page);
    await expect(dialog).toBeVisible({ timeout: 3000 });

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(getModal(page)).not.toBeVisible({ timeout: 3000 });

    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });
});
