/**
 * Space Task Creation E2E Tests
 *
 * Verifies:
 * - "Create Task" action button opens SpaceCreateTaskDialog
 * - Filling and submitting the Create Task form creates a task
 * - Created task title appears in SpaceOverview's Active task list
 * - Cancelling the dialog dismisses it without creating a task
 *
 * Setup: creates a space via RPC (infrastructure), navigates to its overview view
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

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
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'task-creation');
    const spaceName = `E2E Task Creation Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);

    // Navigate directly to the space (overview is the default view)
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // Wait for the space overview to be visible
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
    // SpaceOverview always shows action buttons in the header row
    const createTaskBtn = page.getByRole('button', { name: 'Create Task' }).first();
    await expect(createTaskBtn).toBeVisible({ timeout: 5000 });

    await createTaskBtn.click();

    // The Create Task modal should open — scope assertions to the dialog itself
    const dialog = getModal(page);
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await expect(dialog.getByRole('heading', { name: 'Create Task' })).toBeVisible();
  });

  test('submitting the Create Task form creates a task in Recent Activity', async ({ page }) => {
    const taskTitle = `E2E Task ${Date.now()}`;

    // Click "Create Task" quick action (the first button with that text in SpaceOverview)
    await page.getByRole('button', { name: 'Create Task' }).first().click();

    // Fill in the title field
    const titleInput = page.getByPlaceholder('e.g., Implement authentication module');
    await expect(titleInput).toBeVisible({ timeout: 3000 });
    await titleInput.fill(taskTitle);

    // Submit via the dialog's "Create Task" button — scope to dialog to disambiguate
    const dialog = getModal(page);
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    // Toast notification confirming creation appears
    await expect(page.getByText(`Task "${taskTitle}" created`)).toBeVisible({ timeout: 5000 });

    // Dialog should close after successful submission
    await expect(getModal(page)).not.toBeVisible({ timeout: 3000 });

    // The task title should appear in SpaceOverview's Active task list.
    // Newly created tasks have status 'open' and appear in the Active tab.
    // The store updates reactively via live-query after creation.
    // Use exact: true to avoid matching the taskTitle substring in the toast.
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });
  });

  test('Cancel dismisses the dialog without creating a task', async ({ page }) => {
    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const dialog = getModal(page);
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Click Cancel — dialog should close
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(getModal(page)).not.toBeVisible({ timeout: 3000 });

    // The task pane wrapper (data-testid="space-task-pane") is only mounted in SpaceIsland
    // when activeTaskId is truthy. Cancel never sets a taskId, so the wrapper is absent
    // from the DOM entirely. not.toBeAttached() fails if the element is unexpectedly mounted.
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });
});
