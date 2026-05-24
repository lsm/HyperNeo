/**
 * Canvas Mode Toggle E2E Tests (M7.3)
 *
 * Verifies the canvas mode toggle and workflow visualization in SpaceTaskPane:
 *   - Canvas toggle button appears for workflow-run-backed tasks
 *   - Clicking toggle switches to canvas view (data-testid="canvas-view")
 *   - Canvas renders WorkflowCanvas in runtime mode (data-mode="runtime")
 *   - Workflow nodes are rendered inside the canvas SVG
 *   - Clicking toggle a second time restores the task thread view
 *   - Clicking a workflow node opens the agent overlay chat
 *
 * Setup:
 *   - A unique workspace directory is created in beforeEach.
 *   - Space is created via RPC and a workflow run is started via
 *     spaceWorkflowRun.start — this creates a task whose workflowRunId
 *     and the run's workflowId together satisfy the canvas toggle condition.
 *   - Task is transitioned to "done" so the space runtime does not clear the
 *     manually-linked agent session (runtime skips terminal tasks).
 *   - A lightweight human session is created and linked as taskAgentSessionId
 *     so that onNodeClick is wired (requires agentSessionId to be set) and the
 *     node-click overlay test can open agent-overlay-chat via fallback.
 *
 * Cleanup:
 *   - Workflow run is cancelled via RPC in afterEach.
 *   - Session is deleted via RPC in afterEach.
 *   - Space is deleted via RPC in afterEach.
 *   - Unique workspace directory is removed in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, navigation).
 *   - All assertions check visible DOM state via data-testid selectors.
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Timeout conventions:
 *   - 10000ms: server round-trips (store hydration, RPC calls)
 *   - 5000ms:  local UI state changes (button visibility, panel toggles)
 */

import { existsSync, rmSync } from 'node:fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

interface CanvasTestContext {
  spaceId: string;
  runId: string;
  taskId: string;
  sessionId: string;
  wsPath: string;
}

/**
 * Create a space with a workflow run that produces a task suitable for canvas
 * mode testing.
 *
 * spaceWorkflowRun.start seeds a run linked to the default workflow, creating
 * a task whose workflowRunId + the run's workflowId together satisfy the canvas
 * toggle visibility condition in SpaceTaskPane.
 *
 * The task is then set to 'done' and a human session is linked as
 * taskAgentSessionId so that:
 *   1. The space runtime does not clear the session (it skips terminal tasks).
 *   2. SpaceTaskPane skips ensureTaskAgentSession for terminal tasks.
 *   3. onNodeClick is wired (requires agentSessionId on the task).
 *   4. Node clicks fall back to the task's agent session, opening the overlay.
 */
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

      // 1. Create the space.
      const spaceRes = (await hub.request('space.create', {
        name: `E2E Canvas ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };
      const spaceId = spaceRes.id;

      // 2. Start a workflow run — this creates a task with workflowRunId set
      //    and a run with workflowId, which satisfies the canvas toggle condition.
      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId,
        title: 'E2E: Canvas mode verification',
        description: 'Verify canvas toggle and workflow node rendering.',
      })) as { run: { id: string } };
      const runId = runRes.run.id;

      // 3. Find the task created for this run.
      const tasks = (await hub.request('spaceTask.list', { spaceId })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      const task = tasks.find((t) => t.workflowRunId === runId);
      if (!task) throw new Error(`No task found for run ${runId}`);
      const taskId = task.id;

      // 4. Mark the task as done FIRST — prevents the runtime from clearing
      //    the manually-linked session (runtime only processes non-terminal tasks).
      await hub.request('spaceTask.update', {
        spaceId,
        taskId,
        status: 'done',
      });

      // 5. Create a lightweight human session (no AI).
      const { sessionId: newSessionId } = (await hub.request('session.create', {
        workspacePath: wsPath,
        createdBy: 'human',
      })) as { sessionId: string };

      // 6. Link the session to the done task. The runtime won't clear this
      //    because it only processes non-terminal tasks.
      //    This wires onNodeClick in SpaceTaskPane (requires agentSessionId).
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

/**
 * Cancel a workflow run via RPC. Best-effort for afterEach cleanup.
 */
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
  } catch {
    // Best-effort cleanup
  }
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

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Canvas Mode Toggle', () => {
  // Serial mode: tests share describe-scoped let variables and each beforeEach
  // creates fresh state. Serial execution ensures those variables aren't
  // overwritten mid-test by another test's beforeEach on the same worker.
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
    // Navigate to root and reconnect before cleanup RPC calls.
    try {
      await page.goto('/');
      await waitForWebSocketConnected(page, 5000);
    } catch {
      // Best-effort
    }

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
      } catch {
        // Best-effort cleanup
      }
      wsPath = '';
    }
  });

  // ─── Test 1: Canvas toggle button is visible for workflow run tasks ─────

  test('canvas toggle button is visible on a workflow-run-backed task', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Wait for the task pane to fully hydrate. The canvas toggle only renders
    // when the workflow run (with its workflowId) is loaded in the store.
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await expect(page.getByTestId('canvas-toggle')).toBeVisible({ timeout: 10000 });
  });

  // ─── Test 2: Clicking toggle shows canvas view ──────────────────────────

  test('clicking canvas toggle switches to canvas view', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Wait for toggle to appear.
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });

    // Clicking the toggle should hide the thread panel and show the canvas.
    await page.getByTestId('canvas-toggle').click();

    await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 3: Canvas renders in runtime mode ──────────────────────────────

  test('canvas renders WorkflowCanvas in runtime mode', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    // canvas-view must contain the WorkflowCanvas component.
    await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 5000 });
    const canvas = page.getByTestId('workflow-canvas');
    await expect(canvas).toBeVisible({ timeout: 5000 });

    // Runtime mode is indicated by data-mode="runtime" on the WorkflowCanvas root.
    await expect(canvas).toHaveAttribute('data-mode', 'runtime', { timeout: 5000 });
  });

  // ─── Test 4: Workflow nodes are rendered in the canvas SVG ──────────────

  test('canvas SVG renders workflow nodes', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    // The visual-canvas-svg must be present inside canvas-view.
    await expect(page.getByTestId('visual-canvas-svg')).toBeVisible({ timeout: 5000 });

    // At least one node group should be rendered (nodes use data-testid="node-{id}").
    // Wait for the first node to appear before counting — nodes render after workflow data loads.
    await expect(page.locator('[data-testid^="workflow-node-"]').first()).toBeVisible({
      timeout: 10000,
    });
    const nodeCount = await page.locator('[data-testid^="workflow-node-"]').count();
    expect(nodeCount).toBeGreaterThan(0);
  });

  // ─── Test 5: Clicking toggle again restores the thread view ─────────────

  test('clicking canvas toggle a second time restores task thread panel', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });

    // First click: show canvas.
    await page.getByTestId('canvas-toggle').click();
    await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 5000 });

    // Second click: hide canvas, restore thread panel.
    await page.getByTestId('canvas-toggle').click();
    await expect(page.getByTestId('canvas-view')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 6: Clicking a canvas node opens the agent overlay chat ─────────

  test('clicking a workflow node opens agent overlay chat', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Wait for toggle; task must have a session linked for onNodeClick to fire.
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    // Verify canvas is visible with nodes.
    await expect(page.getByTestId('visual-canvas-svg')).toBeVisible({ timeout: 5000 });
    const firstNode = page.locator('[data-testid^="workflow-node-"]').first();
    await expect(firstNode).toBeVisible({ timeout: 5000 });

    // Click the first node. onNodeClick falls back to the task's agent session
    // (since there are no sub-task sessions for individual nodes), which opens
    // the agent-overlay-chat with our linked human session.
    await firstNode.click();

    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });
  });
});
