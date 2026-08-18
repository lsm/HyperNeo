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
    spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'settings');
    spaceName = `E2E Settings Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);

    await page.goto(`/space/${spaceId}/configure`);
    await page.waitForURL(`/space/${spaceId}/configure`, { timeout: 10000 });

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
    const nameInput = page.locator('input[type="text"]').first();
    await expect(nameInput).toBeVisible();
    await expect(nameInput).toHaveValue(spaceName);

    await expect(page.getByText(spaceWorkspacePath, { exact: true })).toBeVisible({
      timeout: 3000,
    });

    await expect(page.locator('text=Danger Zone')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  });

  test('shows Save Changes button only when form is dirty', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible();

    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill('New Space Name');

    await expect(page.getByRole('button', { name: 'Save Changes' })).toBeVisible({ timeout: 2000 });
  });

  test('edits space name, saves, and persists the change', async ({ page }) => {
    const newName = `Renamed Space ${Date.now()}`;

    const nameInput = page.locator('input[type="text"]').first();
    await nameInput.fill(newName);

    await page.getByRole('button', { name: 'Save Changes' }).click();

    await expect(page.locator('text=Space updated')).toBeVisible({ timeout: 5000 });

    await expect(nameInput).toHaveValue(newName, { timeout: 3000 });

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

    await expect(nameInput).toHaveValue(originalName, { timeout: 2000 });
    await expect(page.getByRole('button', { name: 'Save Changes' })).not.toBeVisible();
  });

  test('Archive space shows confirm dialog and redirects to spaces list', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'Archive', exact: true }).click();

    await page.waitForURL('/spaces', { timeout: 10000 });
  });

  test('Delete space shows confirm dialog and redirects to spaces list', async ({ page }) => {
    page.on('dialog', (dialog) => dialog.accept());

    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await page.waitForURL('/spaces', { timeout: 10000 });

    spaceId = '';
  });
});
