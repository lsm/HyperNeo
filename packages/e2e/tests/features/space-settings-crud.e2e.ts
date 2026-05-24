/**
 * Space Settings CRUD E2E Tests
 *
 * Verifies:
 * - Navigating to the Settings tab of a space
 * - Editing space name and saving persists changes
 * - Discarding reverts edits without saving
 * - Archiving a space redirects to the spaces list
 * - Deleting a space redirects to the spaces list
 *
 * Setup: creates a space via RPC (infrastructure), navigates to its Settings tab
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Settings CRUD', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let spaceName = '';
  let spaceWorkspacePath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
    spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'settings');
    spaceName = `E2E Settings Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);

    // Navigate directly to the configure view (which hosts the Settings tab)
    await page.goto(`/space/${spaceId}/configure`);
    await page.waitForURL(`/space/${spaceId}/configure`, { timeout: 10000 });

    // Click the Settings tab (role="tab", identified by data-testid)
    await page.getByTestId('space-configure-tab-settings').click();
    await expect(page.locator('text=Danger Zone')).toBeVisible({ timeout: 5000 });
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
  });

  test('renders settings tab with name, description, workspace path', async ({ page }) => {
    // Name input should be visible and pre-populated with the space name
    const nameInput = page.locator('input[type="text"]').first();
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue(spaceName);

    // Workspace path should be shown as read-only text (the unique subdirectory for this test)
    await expect(page.getByText(spaceWorkspacePath, { exact: true })).toBeVisible({
      timeout: 3000,
    });

    // Danger Zone section
    await expect(page.locator('text=Danger Zone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  });

  test('shows Save Changes button only when form is dirty', async ({ page }) => {
    // Save Changes not visible initially
    await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible();

    // Type something in the name field
    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill('New Space Name');

    // Save Changes should now appear
    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible({ timeout: 2000 });
  });

  test('edits space name, saves, and persists the change', async ({ page }) => {
    const newName = `Renamed Space ${Date.now()}`;

    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill(newName);

    await page.getByRole('button', { name: 'Save Changes' }).click();

    // Toast notification of success
    await expect(page.locator('text=Space updated')).toBeVisible({ timeout: 5000 });

    // The input should now reflect the saved name
    await expect(nameInput).toHaveValue(newName, { timeout: 3000 });

    // Save Changes button should disappear (form is clean again)
    await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible({
      timeout: 3000,
    });
  });

  test('Discard button reverts unsaved edits', async ({ page }) => {
    const nameInput = page.locator('input[type="text"]').first();
    const originalName = await nameInput.inputValue();

    await nameInput.fill('Temporary Name');
    await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible({ timeout: 2000 });

    await page.getByRole('button', { name: 'Discard' }).click();

    // Name should revert to original
    await expect(nameInput).toHaveValue(originalName, { timeout: 2000 });
    // Save Changes should disappear
    await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible();
  });

  test('Archive space shows confirm dialog and redirects to spaces list', async ({ page }) => {
    // Accept the browser confirm dialog
    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'Archive', exact: true }).click();

    // Should redirect to /spaces
    await page.waitForURL('/spaces', { timeout: 10000 });
    // spaceId is intentionally left set — afterEach will delete the (archived) space via
    // space.delete, which succeeds regardless of archive status.
  });

  test('Delete space shows confirm dialog and redirects to spaces list', async ({ page }) => {
    // Accept the browser confirm dialog
    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    // Should redirect to /spaces
    await page.waitForURL('/spaces', { timeout: 10000 });

    // Space is already deleted — don't double-delete in afterEach
    spaceId = '';
  });
});
