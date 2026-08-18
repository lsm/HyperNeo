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
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'agent-chat');
    const spaceName = `E2E Agent Chat Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    await deleteSpaceWorkflowsViaRpc(page, spaceId);

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
    await expect(page.getByTestId('space-overview-view')).toBeVisible({
      timeout: 5000,
    });

    await page.getByRole('button', { name: 'Space Agent', exact: true }).click();

    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    const messageInput = page.getByTestId('chat-container').locator('textarea');
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    await expect(page.getByTestId('space-overview-view')).not.toBeVisible();
  });

  test('navigating back to space base route returns to tab view', async ({ page }) => {
    await page.getByRole('button', { name: 'Space Agent', exact: true }).click();
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    const messageInput = page.getByTestId('chat-container').locator('textarea');
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.getByTestId('space-overview-view')).toBeVisible({
      timeout: 5000,
    });

    await expect(messageInput).not.toBeVisible();
  });
});
