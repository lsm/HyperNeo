import { existsSync, rmSync } from 'node:fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

interface CanvasTestContext {
  spaceId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  wsPath: string;
}

async function createSpaceWithCanvasRun(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<CanvasTestContext> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'canvas');

  const result = await page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const spaceRes = (await hub.request('space.create', {
        name: `E2E Canvas ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };
      const spaceId = spaceRes.id;

      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId,
        title: 'E2E: Canvas mode verification',
        description: 'Verify canvas toggle and workflow node rendering.',
      })) as { run: { id: string } };
      const runId = runRes.run.id;

      const tasks = (await hub.request('spaceTask.list', { spaceId })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      const task = tasks.find((t) => t.workflowRunId === runId);
      if (!task) throw new Error(`No task found for run ${runId}`);
      const taskId = task.id;

      await hub.request('spaceTask.update', {
        spaceId,
        taskId,
        status: 'done',
      });

      const { sessionId: newSessionId } = (await hub.request('session.create', {
        workspacePath: wsPath,
        createdBy: 'human',
      })) as { sessionId: string };

      await hub.request('spaceTask.update', {
        spaceId,
        taskId,
        taskAgentSessionId: newSessionId,
      });

      return { spaceId, runId, taskId, sessionId: newSessionId };
    },
    { wsPath }
  );

  return { ...result, wsPath };
}

async function cancelRunViaRpc(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  runId: string
): Promise<void> {
  if (!runId) return;
  try {
    await page.evaluate(async (rid) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('spaceWorkflowRun.cancel', { id: rid });
    }, runId);
  } catch {}
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

test.describe('Canvas Mode Toggle', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let runId = '';
  let taskId = '';
  let sessionId = '';
  let wsPath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ctx = await createSpaceWithCanvasRun(page);
    spaceId = ctx.spaceId;
    runId = ctx.runId;
    taskId = ctx.taskId;
    sessionId = ctx.sessionId;
    wsPath = ctx.wsPath;
  });

  test.afterEach(async ({ page }) => {
    try {
      await page.goto('/');
      await waitForWebSocketConnected(page, 5000);
    } catch {}

    if (runId) {
      await cancelRunViaRpc(page, runId);
      runId = '';
    }
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

  test('canvas toggle button is visible on a workflow-run-backed task', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await expect(page.getByTestId('canvas-toggle')).toBeVisible({ timeout: 10000 });
  });

  test('clicking canvas toggle switches to canvas view', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });

    await page.getByTestId('canvas-toggle').click();

    await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 5000 });
  });

  test('canvas renders WorkflowCanvas in runtime mode', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 5000 });
    const canvas = page.getByTestId('workflow-canvas');
    await expect(canvas).toBeVisible({ timeout: 5000 });

    await expect(canvas).toHaveAttribute('data-mode', 'runtime', { timeout: 5000 });
  });

  test('canvas SVG renders workflow nodes', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    await expect(page.getByTestId('visual-canvas-svg')).toBeVisible({ timeout: 5000 });

    await expect(page.locator('[data-testid^="workflow-node-"]').first()).toBeVisible({
      timeout: 10000,
    });
    const nodeCount = await page.locator('[data-testid^="workflow-node-"]').count();
    expect(nodeCount).toBeGreaterThan(0);
  });

  test('clicking canvas toggle a second time restores task thread panel', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });

    await page.getByTestId('canvas-toggle').click();
    await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('canvas-toggle').click();
    await expect(page.getByTestId('canvas-view')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
  });

  test('clicking a workflow node opens agent overlay chat', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    await expect(page.getByTestId('visual-canvas-svg')).toBeVisible({ timeout: 5000 });
    const firstNode = page.locator('[data-testid^="workflow-node-"]').first();
    await expect(firstNode).toBeVisible({ timeout: 5000 });

    await firstNode.click();

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });
  });
});
