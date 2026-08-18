import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('ContextPanel Space Switching (Level 1 ↔ Level 2)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let createdSpaceId = '';
  let spaceName = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);
    await expect(page.getByRole('button', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'ctx-panel');
    spaceName = `E2E SwitchTest ${Date.now()}`;
    createdSpaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
  });

  test.afterEach(async ({ page }) => {
    if (createdSpaceId) {
      await deleteSpaceViaRpc(page, createdSpaceId);
      createdSpaceId = '';
    }
  });

  test('shows Spaces title and SpaceContextPanel when at spaces list level', async ({ page }) => {
    await page.getByRole('button', { name: 'Spaces', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
  });

  test('shows SpaceDetailPanel with pinned items when a space is selected', async ({ page }) => {
    await page.goto(`/space/${createdSpaceId}`);
    await waitForWebSocketConnected(page);

    await expect(page.getByTestId('space-detail-dashboard')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Space Agent')).toBeVisible({ timeout: 5000 });

    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
  });

  test('shows space name in ContextPanel header when inside a space', async ({ page }) => {
    await page.goto(`/space/${createdSpaceId}`);
    await waitForWebSocketConnected(page);

    await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });
  });

  test('back button navigates from space detail to spaces list', async ({ page }) => {
    await page.goto(`/space/${createdSpaceId}`);
    await waitForWebSocketConnected(page);

    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });

    await page.getByTitle('Back to Spaces').click();

    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
  });

  test('clicking a space from the list navigates to SpaceDetailPanel', async ({ page }) => {
    await page.getByRole('button', { name: 'Spaces', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByText(spaceName)).toBeVisible({ timeout: 5000 });

    await page.getByText(spaceName).first().click();

    await expect(page.getByTestId('space-detail-dashboard')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
  });
});
