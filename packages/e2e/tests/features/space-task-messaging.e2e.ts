import { existsSync, rmSync } from 'node:fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createSpaceTaskViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

interface TaskMessagingTestContext {
  spaceId: string;
  taskId: string;
  sessionId: string;
  wsPath: string;
}

async function createSpaceWithMessagingTask(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<TaskMessagingTestContext> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'task-msg');

  const spaceName = `E2E Task Messaging ${Date.now()}`;
  const spaceId = await createSpaceViaRpc(page, wsPath, spaceName);
  const taskId = await createSpaceTaskViaRpc(page, spaceId, 'Messaging test task');

  const sessionId = await page.evaluate(
    async ({ wsPath, spaceId, taskId }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const { sessionId: newSessionId } = (await hub.request('session.create', {
        workspacePath: wsPath,
        createdBy: 'human',
      })) as { sessionId: string };

      await hub.request('spaceTask.update', {
        spaceId,
        taskId,
        taskAgentSessionId: newSessionId,
        status: 'in_progress',
      });

      return newSessionId;
    },
    { wsPath, spaceId, taskId }
  );

  return { spaceId, taskId, sessionId, wsPath };
}

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

test.describe('Space Task Messaging & @mention Autocomplete', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let taskId = '';
  let sessionId = '';
  let wsPath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ctx = await createSpaceWithMessagingTask(page);
    spaceId = ctx.spaceId;
    taskId = ctx.taskId;
    sessionId = ctx.sessionId;
    wsPath = ctx.wsPath;
  });

  test.afterEach(async ({ page }) => {
    if (sessionId) {
      await deleteSessionViaRpc(page, sessionId);
      sessionId = '';
    }
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
    taskId = '';
    if (wsPath && existsSync(wsPath)) {
      try {
        rmSync(wsPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      wsPath = '';
    }
  });

  test('inline composer textarea renders when task has a taskAgentSessionId', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await expect(page.getByTestId('task-thread-panel')).toBeAttached({ timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });
  });

  test('user can type a message and submit it via Enter key', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });

    const testMessage = 'Hello from E2E test';
    await composerTextarea.click();
    await composerTextarea.pressSequentially(testMessage, { delay: 10 });

    await expect(composerTextarea).toHaveValue(testMessage, { timeout: 3000 });

    await composerTextarea.press('Enter');

    await Promise.race([
      expect(composerTextarea).toHaveValue('', { timeout: 10000 }),
      expect(page.locator('p.text-red-300')).toBeVisible({ timeout: 10000 }),
    ]);
  });

  test('Shift+Enter inserts a newline rather than submitting', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });

    await composerTextarea.click();
    await composerTextarea.pressSequentially('Line one', { delay: 10 });

    await composerTextarea.press('Shift+Enter');
    await composerTextarea.pressSequentially('Line two', { delay: 10 });

    const value = await composerTextarea.inputValue();
    expect(value).toContain('Line one');
    expect(value).toContain('Line two');
  });

  test('@mention: autocomplete does NOT appear for non-workflow tasks', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const composerTextarea = page.getByPlaceholder('Message task agent...');
    await expect(composerTextarea).toBeVisible({ timeout: 10000 });

    await composerTextarea.click();
    await composerTextarea.pressSequentially('@', { delay: 10 });

    await expect(page.getByTestId('mention-autocomplete')).not.toBeVisible({ timeout: 3000 });

    const value = await composerTextarea.inputValue();
    expect(value).toBe('@');
  });
});
