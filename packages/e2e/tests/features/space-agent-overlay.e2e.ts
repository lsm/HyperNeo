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

interface OverlayTestContext {
  spaceId: string;
  taskId: string;
  sessionId: string;
  wsPath: string;
}

async function createSpaceWithTaskAndSession(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<OverlayTestContext> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'overlay');

  const spaceName = `E2E Overlay ${Date.now()}`;
  const spaceId = await createSpaceViaRpc(page, wsPath, spaceName);
  const taskId = await createSpaceTaskViaRpc(page, spaceId, 'Overlay test task');

  const sessionId = await page.evaluate(
    async ({ wsPath: wp, spaceId: sid, taskId: tid }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      await hub.request('spaceTask.update', { spaceId: sid, taskId: tid, status: 'done' });

      const { sessionId: newSessionId } = (await hub.request('session.create', {
        workspacePath: wp,
        createdBy: 'human',
      })) as { sessionId: string };

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
  } catch {}
}

async function openOverlay(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  sessionId: string,
  agentName = 'Task Agent'
): Promise<void> {
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__hyperneo_space_overlay, {
    timeout: 10000,
  });
  await page.evaluate(
    ({ sid, name }) => {
      type Api = { open: (s: string, n: string) => void };
      const api = (window as Record<string, unknown>).__hyperneo_space_overlay as Api;
      api.open(sid, name);
    },
    { sid: sessionId, name: agentName }
  );
}

test.describe('Agent Overlay Chat', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let taskId = '';
  let sessionId = '';
  let wsPath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ctx = await createSpaceWithTaskAndSession(page);
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
      } catch {}
      wsPath = '';
    }
  });

  test('opening the overlay shows the agent overlay panel', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });
  });

  test('task view is still visible underneath while overlay is open', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    expect(page.url()).toContain(`/space/${spaceId}/task/${taskId}`);

    await expect(page.getByTestId('task-thread-panel')).toBeAttached({ timeout: 5000 });
  });

  test('overlay surfaces the agent name via the dialog aria-label', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    const overlay = page.getByTestId('agent-overlay-chat');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    const ariaLabel = await overlay.getAttribute('aria-label');
    expect(ariaLabel?.trim().length).toBeGreaterThan(0);
    expect(ariaLabel).toMatch(/chat$/);
  });

  test('back button in the chat header dismisses the overlay', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('chat-header-back').click();

    await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });

    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
  });

  test('pressing Escape dismisses the overlay', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });
  });

  test('clicking the backdrop dismisses the overlay', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    const backdrop = page.getByTestId('agent-overlay-chat').locator('[aria-hidden="true"]').first();
    await backdrop.click({ position: { x: 100, y: 100 } });

    await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });
  });
});
