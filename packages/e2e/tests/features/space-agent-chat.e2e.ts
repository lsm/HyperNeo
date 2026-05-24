/**
 * Space Agent Chat E2E Tests
 *
 * Verifies that clicking "Space Agent" in SpaceDetailPanel renders ChatContainer
 * in the ContentPanel, and that navigating away returns to the tab view.
 *
 * Setup: creates a space via RPC (infrastructure), navigates to it
 * Cleanup: deletes the space via RPC in afterEach (infrastructure)
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
  deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

test.describe('Space Agent Chat', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    // Use a unique subdirectory to avoid conflicts with other parallel tests
    // (workspace_path has a UNIQUE constraint in the DB).
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'agent-chat');
    const spaceName = `E2E Agent Chat Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    // Delete seeded built-in workflows so showCanvas=false and SpaceOverview is
    // visible on desktop viewports (otherwise md:hidden hides it behind WorkflowCanvas).
    await deleteSpaceWorkflowsViaRpc(page, spaceId);

    // Navigate to the space
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
  });

  test('clicking Space Agent in SpaceDetailPanel renders ChatContainer with message input', async ({
    page,
  }) => {
    // The space overview should be visible by default
    await expect(page.getByTestId('space-overview-view')).toBeVisible({
      timeout: 5000,
    });

    // Click "Space Agent" in the SpaceDetailPanel (context panel)
    await page.getByRole('button', { name: 'Space Agent', exact: true }).click();

    // URL should update to the agent route
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // ChatContainer should render — message input textarea should be visible
    const messageInput = page.getByTestId('chat-container').locator('textarea');
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    // The space overview should no longer be visible (ChatContainer replaced it)
    await expect(page.getByTestId('space-overview-view')).not.toBeVisible();
  });

  test('navigating back to space base route returns to tab view', async ({ page }) => {
    // Click Space Agent to enter chat view
    await page.getByRole('button', { name: 'Space Agent', exact: true }).click();
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // Message input should be visible
    const messageInput = page.getByTestId('chat-container').locator('textarea');
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    // Navigate back to space overview
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // Space overview should be back
    await expect(page.getByTestId('space-overview-view')).toBeVisible({
      timeout: 5000,
    });

    // Message input should no longer be visible
    await expect(messageInput).not.toBeVisible();
  });
});
