import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createUniqueSpaceDir,
  createSpaceTaskViaRpc,
  deleteSpaceViaRpc,
  deleteSpaceWorkflowsViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1280, height: 720 };

const OVERVIEW_VIEW = '[data-testid="space-overview-view"]';

test.describe('Comprehensive Space Navigation', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let spaceName = '';
  let taskId = '';
  let taskTitle = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'nav');
    spaceName = `E2E SpaceNav ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    await deleteSpaceWorkflowsViaRpc(page, spaceId);
    taskTitle = `Nav Task ${Date.now()}`;
    taskId = await createSpaceTaskViaRpc(page, spaceId, taskTitle);
  });

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
      taskId = '';
    }
    spaceName = '';
    taskTitle = '';
  });

  test('Level 1→2: NavRail Spaces → SpacesPage → click space card → SpaceDetailPanel', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Spaces', exact: true }).click();

    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });

    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();

    await page.getByText(spaceName, { exact: true }).first().click();

    await expect(page.locator('[data-testid="space-detail-dashboard"]')).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('[data-testid="space-detail-agent"]')).toBeVisible({ timeout: 5000 });

    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('heading', { name: spaceName }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('Space Agent: click → ChatContainer renders → sidebar item is active', async ({ page }) => {
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 5000 });

    await page.locator('[data-testid="space-detail-agent"]').click();

    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached();

    await expect(page.locator('[data-testid="space-detail-agent"]')).toHaveAttribute(
      'data-active',
      'true'
    );
  });

  test('Overview: click → SpaceOverview returns → Active/Review/Done tabs clickable', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/agent`);
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached({ timeout: 5000 });

    await page.locator('[data-testid="space-detail-dashboard"]').click();

    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 5000 });

    await expect(page.getByRole('heading', { name: spaceName })).toBeVisible({ timeout: 10000 });
    await expect(page.locator(OVERVIEW_VIEW).locator('text="Space not found"')).not.toBeAttached({
      timeout: 10000,
    });

    const overviewView = page.locator(OVERVIEW_VIEW);
    for (const tabName of ['Active', 'Review', 'Done']) {
      const tab = overviewView.getByRole('button', { name: new RegExp(tabName) });
      await expect(tab).toBeVisible({ timeout: 5000 });
      await tab.click();
      await expect(tab).toBeVisible({ timeout: 2000 });
    }
  });

  test('Task: click task → full-width pane → back → dashboard returns', async ({ page }) => {
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 5000 });

    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible({ timeout: 5000 });

    await page.getByText(taskTitle, { exact: true }).first().click();
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 5000 });

    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 3000 });

    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached();

    await page.locator('[data-testid="task-back-button"]').click();
    await page.waitForURL(`/space/${spaceId}`, { timeout: 5000 });

    await expect(page.locator(OVERVIEW_VIEW)).toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  test('Level 2→1: back button → SpacesPage content', async ({ page }) => {
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    await expect(page.getByTitle('Back to Spaces')).toBeVisible({ timeout: 10000 });

    await page.getByTitle('Back to Spaces').click();

    await expect(page.getByRole('button', { name: 'New Space', exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByRole('heading', { name: 'Spaces', exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTitle('Back to Spaces')).not.toBeVisible();
  });

  test('deep link /space/:id/agent → space loads with ChatContainer', async ({ page }) => {
    await page.goto(`/space/${spaceId}/agent`);
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    await waitForWebSocketConnected(page);

    await expect(page.getByRole('heading', { name: spaceName }).first()).toBeVisible({
      timeout: 10000,
    });

    await expect(page.locator('[data-testid="space-detail-agent"]')).toBeVisible({ timeout: 5000 });

    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    await expect(page.locator(OVERVIEW_VIEW)).not.toBeAttached();
  });
});
