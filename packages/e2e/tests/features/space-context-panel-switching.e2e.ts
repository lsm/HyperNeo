/**
 * Space Navigation Switching E2E Tests
 *
 * Verifies the Level 1 ↔ Level 2 switching in the Spaces section:
 * - Level 1 (spaces list): SpacesPage renders full-width, "New Space" button in header
 * - Level 2 (space detail): SpaceDetailPanel visible in sidebar, space name in header, back button present
 * - Back button navigates from detail back to list
 *
 * Setup: creates a space via RPC in beforeEach (infrastructure)
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
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
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
    // Navigate to spaces section
    await page.getByRole('button', { name: 'Spaces', exact: true }).click();

    // Header should show "Spaces" — not "Home"
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    // SpacesPage header "New Space" button should be visible
    // Use .first() — the page now has two "New Space" buttons (header + dashed card).
    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    // Back button should NOT be visible at list level
    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
  });

  test('shows SpaceDetailPanel with pinned items when a space is selected', async ({ page }) => {
    // Navigate to the space directly via URL
    await page.goto(`/space/${createdSpaceId}`);
    await waitForWebSocketConnected(page);

    // SpaceDetailPanel should render pinned items: Overview and Space Agent
    await expect(page.getByTestId('space-detail-dashboard')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Space Agent')).toBeVisible({ timeout: 5000 });

    // Back button should be visible
    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
  });

  test('shows space name in ContextPanel header when inside a space', async ({ page }) => {
    await page.goto(`/space/${createdSpaceId}`);
    await waitForWebSocketConnected(page);

    // Header should show the space name
    await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });
  });

  test('back button navigates from space detail to spaces list', async ({ page }) => {
    // Start inside a space
    await page.goto(`/space/${createdSpaceId}`);
    await waitForWebSocketConnected(page);

    // Verify we're in space detail
    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });

    // Click the back button
    await page.getByTitle('Back to Spaces').click();

    // Should now show the spaces list
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    // SpacesPage "New Space" button should be visible
    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    // Back button should be gone
    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
  });

  test('clicking a space from the list navigates to SpaceDetailPanel', async ({ page }) => {
    // Go to the spaces section list
    await page.getByRole('button', { name: 'Spaces', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    // Wait for the space to appear in the list (LiveQuery may need a moment to load)
    await expect(page.getByText(spaceName)).toBeVisible({ timeout: 5000 });

    // SpacesPage renders each space as a card button — clicking navigates directly.
    await page.getByText(spaceName).first().click();

    // Should now be inside the space — SpaceDetailPanel pinned items visible
    await expect(page.getByTestId('space-detail-dashboard')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
  });
});
