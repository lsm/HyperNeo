/**
 * Space Task Full-Width View E2E Tests
 *
 * Verifies:
 * - Clicking a task in SpaceDetailPanel opens the full-width task pane
 * - Tab bar is hidden when the full-width task view is active
 * - Back button in task view returns to the tabbed dashboard view
 * - Task pane is not attached to the DOM when no task is selected
 *
 * Setup: creates a space and a task via RPC (infrastructure), navigates to the space
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

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
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'task-fullwidth');
    const spaceName = `E2E Full-Width Task Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    // Delete seeded built-in workflows so showCanvas=false and SpaceOverview is
    // visible on desktop viewports (otherwise md:hidden hides it behind WorkflowCanvas).
    await deleteSpaceWorkflowsViaRpc(page, spaceId);

    // Navigate to the space dashboard
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // Wait for the Overview button to be visible (confirms SpaceOverview is loaded)
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

    // Create a task via UI — click "Create Task" quick action
    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const dialog = getModal(page);
    await expect(dialog).toBeVisible({ timeout: 3000 });

    await dialog.getByPlaceholder('e.g., Implement authentication module').fill(taskTitle);
    await dialog.getByRole('button', { name: 'Create Task' }).click();

    // Wait for task to appear in SpaceOverview's Recent Activity section
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    // Overview entry should be visible before clicking a task
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();

    // Click the task title link in SpaceDetailPanel (context panel) or SpaceOverview
    // The task title appears as a clickable element in the context panel's task list
    await page.getByText(taskTitle, { exact: true }).first().click();

    // Wait for navigation to the task route
    await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

    // Full-width task pane should now be visible
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    // Overview surface should be unmounted in full-width task mode.
    // The Overview button in SpaceDetailPanel (left sidebar) always remains visible.
    await expect(page.getByTestId('space-overview-view')).not.toBeAttached({ timeout: 3000 });
  });

  test('back button in task view returns to the tabbed dashboard', async ({ page }) => {
    const taskTitle = `Back Button Task ${Date.now()}`;

    // Create task via UI
    await page.getByRole('button', { name: 'Create Task' }).first().click();

    const dialog = getModal(page);
    await dialog.getByPlaceholder('e.g., Implement authentication module').fill(taskTitle);
    await dialog.getByRole('button', { name: 'Create Task' }).click();
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    // Navigate to task
    await page.getByText(taskTitle, { exact: true }).first().click();
    await page.waitForURL(`/space/${spaceId}/task/**`, { timeout: 5000 });

    // Verify task pane is shown
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    // Click the back button
    await page.locator('[data-testid="task-back-button"]').click();

    // Should return to the space dashboard URL
    await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

    // Tab bar should be visible again
    await expect(page.getByRole('button', { name: 'Overview', exact: true })).toBeVisible({
      timeout: 3000,
    });

    // Task pane should no longer be shown
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  test('task pane is not attached before any task is selected', async ({ page }) => {
    // No task selected — task pane should not be in the DOM
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });
});
