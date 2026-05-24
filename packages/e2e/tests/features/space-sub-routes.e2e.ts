/**
 * Space Sub-Routes Deep Link E2E Tests
 *
 * Verifies all four space URL patterns render the correct content when
 * navigated to directly (deep links) and that browser back/forward works:
 *
 *   /space/:id               → dashboard tabs (SpaceIsland default)
 *   /space/:id/agent         → ChatContainer (space agent chat)
 *   /space/:id/session/:sid  → ChatContainer (session within space)
 *   /space/:id/task/:tid     → SpaceTaskPane (full-width task view)
 *
 * Setup: creates a space, a task, and a session via RPC (infrastructure)
 * Cleanup: deletes the space and session via RPC in afterEach (infrastructure)
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

/**
 * Create a task via RPC. For use in beforeEach setup only.
 * Returns the new task's id.
 */
async function createTaskViaRpc(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  spaceId: string,
  title: string
): Promise<string> {
  const id = await page.evaluate(
    async ({ spaceId, title }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      const task = (await hub.request('spaceTask.create', {
        spaceId,
        title,
        description: '',
      })) as { id: string };
      return task.id;
    },
    { spaceId, title }
  );
  if (!id) throw new Error('spaceTask.create returned no id');
  return id;
}

/**
 * Create a standalone session via RPC. For use in beforeEach setup only.
 * Returns the new session's id (a UUID).
 */
async function createSessionViaRpc(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  workspacePath: string
): Promise<string> {
  const id = await page.evaluate(async (path) => {
    const hub = window.__messageHub || window.appState?.messageHub;
    if (!hub?.request) throw new Error('MessageHub not available');
    const result = (await hub.request('session.create', {
      workspacePath: path,
      title: 'E2E space session route test',
    })) as { sessionId: string };
    return result.sessionId;
  }, workspacePath);
  if (!id) throw new Error('session.create returned no id');
  return id;
}

/**
 * Delete a session via RPC. Best-effort for afterEach cleanup.
 */
async function deleteSessionViaRpc(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  sessionId: string
): Promise<void> {
  if (!sessionId) return;
  try {
    await page.evaluate(async (id) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('session.delete', { sessionId: id });
    }, sessionId);
  } catch {
    // Best-effort cleanup
  }
}

test.describe('Space Sub-Routes Deep Links', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let taskId = '';
  let sessionId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForWebSocketConnected(page);

    const workspaceRoot = await getWorkspaceRoot(page);
    // Use a unique subdirectory per test to avoid conflicts with other parallel tests
    // that also create spaces (workspace_path has a UNIQUE constraint in the DB).
    const spaceWorkspacePath = createUniqueSpaceDir(workspaceRoot, 'sub-routes');
    const spaceName = `E2E Sub-Routes Test ${Date.now()}`;
    spaceId = await createSpaceViaRpc(page, spaceWorkspacePath, spaceName);
    // Delete seeded built-in workflows so showCanvas=false and SpaceOverview is
    // visible on desktop viewports (otherwise md:hidden hides it behind WorkflowCanvas).
    await deleteSpaceWorkflowsViaRpc(page, spaceId);
    taskId = await createTaskViaRpc(page, spaceId, `Test Task ${Date.now()}`);
    sessionId = await createSessionViaRpc(page, workspaceRoot);
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      await deleteSessionViaRpc(page, sessionId);
      sessionId = '';
    }
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
      taskId = '';
    }
  });

  test('direct navigation to /space/:id renders dashboard tabs', async ({ page }) => {
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });

    // Space overview should be visible (default route renders SpaceOverview)
    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

    // No ChatContainer or task pane
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  test('direct navigation to /space/:id/agent renders ChatContainer', async ({ page }) => {
    await page.goto(`/space/${spaceId}/agent`);
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // ChatContainer message input should be visible
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    // Space overview should not be visible (ChatContainer replaced it)
    await expect(page.getByTestId('space-overview-view')).not.toBeVisible();

    // No task pane
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  test('direct navigation to /space/:id/session/:sid renders ChatContainer', async ({ page }) => {
    await page.goto(`/space/${spaceId}/session/${sessionId}`);
    await page.waitForURL(`/space/${spaceId}/session/${sessionId}`, { timeout: 10000 });

    // ChatContainer message input should be visible
    const messageInput = page.locator('textarea[placeholder*="Ask"]').first();
    await expect(messageInput).toBeVisible({ timeout: 10000 });

    // Space overview should not be visible (ChatContainer replaced it)
    await expect(page.getByTestId('space-overview-view')).not.toBeVisible();

    // No task pane
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();
  });

  test('direct navigation to /space/:id/task/:tid renders SpaceTaskPane', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Full-width task pane should be visible
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 5000 });

    // Space overview should not be visible (task pane replaced it)
    await expect(page.getByTestId('space-overview-view')).not.toBeVisible();
  });

  test('browser back/forward navigates correctly between space views', async ({ page }) => {
    // Step 1: Start at dashboard
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

    // Step 2: Navigate to agent chat
    await page.goto(`/space/${spaceId}/agent`);
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });
    await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
      timeout: 10000,
    });

    // Step 3: Navigate to task view
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await expect(page.locator('[data-testid="space-task-pane"]')).toBeVisible({ timeout: 5000 });

    // Step 4: Browser back — should return to agent chat
    await page.goBack();
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });
    await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator('[data-testid="space-task-pane"]')).not.toBeAttached();

    // Step 5: Browser back — should return to dashboard
    await page.goBack();
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

    // Step 6: Browser forward — should return to agent chat
    await page.goForward();
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });
    await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
      timeout: 10000,
    });
  });

  test('clicking Space Agent in sidebar navigates to /agent route and back returns to dashboard', async ({
    page,
  }) => {
    // Navigate to the space dashboard
    await page.goto(`/space/${spaceId}`);
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });

    // Click "Space Agent" in the SpaceDetailPanel sidebar
    await page.getByRole('button', { name: 'Space Agent', exact: true }).click();
    await page.waitForURL(`/space/${spaceId}/agent`, { timeout: 10000 });

    // ChatContainer should be visible
    await expect(page.locator('textarea[placeholder*="Ask"]').first()).toBeVisible({
      timeout: 10000,
    });
    // Space overview should be hidden (ChatContainer replaced the overview)
    await expect(page.getByTestId('space-overview-view')).not.toBeVisible();

    // Browser back returns to dashboard
    await page.goBack();
    await page.waitForURL(`/space/${spaceId}`, { timeout: 10000 });
    await expect(page.getByTestId('space-overview-view')).toBeVisible({ timeout: 5000 });
  });
});
