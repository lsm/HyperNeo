import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir, deleteSpaceViaRpc } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };
const RUN_TASK_LOOKUP_TIMEOUT_MS = 20000;
const RUN_TASK_LOOKUP_INTERVAL_MS = 250;

async function createSpaceWithRun(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ spaceId: string; runId: string }> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'happy-path');

  return page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const spaceRes = (await hub.request('space.create', {
        name: `E2E Task-First ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };

      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId: spaceRes.id,
        title: 'E2E: Task-first runtime flow',
        description: 'Validate task thread lifecycle for workflow-backed tasks.',
      })) as { run: { id: string } };

      return { spaceId: spaceRes.id, runId: runRes.run.id };
    },
    { wsPath }
  );
}

async function cancelRun(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  runId: string
): Promise<void> {
  try {
    await page.evaluate(async (rid) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('spaceWorkflowRun.cancel', { id: rid });
    }, runId);
  } catch {
    // best-effort cleanup
  }
}

async function getRunTaskId(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  spaceId: string,
  runId: string
): Promise<string> {
  await page.waitForFunction(
    async ({ sid, rid }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return false;
      const tasks = (await hub.request('spaceTask.list', { spaceId: sid })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      return tasks.some((t) => t.workflowRunId === rid);
    },
    { sid: spaceId, rid: runId },
    { timeout: RUN_TASK_LOOKUP_TIMEOUT_MS, polling: RUN_TASK_LOOKUP_INTERVAL_MS }
  );

  const taskId = await page.evaluate(
    async ({ sid, rid }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      const tasks = (await hub.request('spaceTask.list', { spaceId: sid })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      const match = tasks.find((t) => t.workflowRunId === rid);
      return match?.id ?? '';
    },
    { sid: spaceId, rid: runId }
  );

  if (!taskId) throw new Error(`No task found for run ${runId}`);
  return taskId;
}

async function gotoAndWaitForConnection(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  url: string
): Promise<void> {
  await page.goto(url);
  await waitForWebSocketConnected(page);
}

test.describe('Space Happy Path Pipeline (Task-First)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let runId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ids = await createSpaceWithRun(page);
    spaceId = ids.spaceId;
    runId = ids.runId;
  });

  test.afterEach(async ({ page }) => {
    try {
      await page.goto('/');
      await waitForWebSocketConnected(page, 5000);
    } catch {
      // If navigation/connection fails, cleanup below will be best-effort
    }

    if (runId) {
      await cancelRun(page, runId);
      runId = '';
    }
    if (spaceId) {
      await deleteSpaceViaRpc(page, spaceId);
      spaceId = '';
    }
  });

  test('seeded agents and workflows are present', async ({ page }) => {
    await gotoAndWaitForConnection(page, `/space/${spaceId}/configure`);
    await page.waitForURL(`/space/${spaceId}/configure`, { timeout: 10000 });

    await expect(page.getByTestId('space-configure-tab-agents')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Planner', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Coder', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('General', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Research', { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText('Reviewer', { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText('QA', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    await page.getByTestId('space-configure-tab-workflows').click();
    await expect(page.getByText('Coding with QA', { exact: true })).toBeVisible({
      timeout: 5000,
    });
  });

  test('workflow run task opens task route and shows thread activity', async ({ page }) => {
    const taskId = await getRunTaskId(page, spaceId, runId);

    await gotoAndWaitForConnection(page, `/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });

    await page.evaluate(
      async ({ sid, tid }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('MessageHub not available');
        await hub.request('space.task.ensureAgentSession', { spaceId: sid, taskId: tid });
        await hub.request('space.task.sendMessage', {
          spaceId: sid,
          taskId: tid,
          message: 'E2E ping: continue the task and report status.',
        });
      },
      { sid: spaceId, tid: taskId }
    );

    await expect(page.getByTestId('space-task-event-row').first()).toBeVisible({ timeout: 15000 });
  });

  test('task completion is reflected in task pane', async ({ page }) => {
    const taskId = await getRunTaskId(page, spaceId, runId);

    await gotoAndWaitForConnection(page, `/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await page.evaluate(
      async ({ sid, tid }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('MessageHub not available');
        const current = (await hub.request('spaceTask.get', {
          spaceId: sid,
          taskId: tid,
        })) as { status: string };
        if (current.status === 'pending') {
          await hub.request('spaceTask.update', {
            spaceId: sid,
            taskId: tid,
            status: 'in_progress',
          });
        }
        await hub.request('spaceTask.update', { spaceId: sid, taskId: tid, status: 'done' });
      },
      { sid: spaceId, tid: taskId }
    );

    await expect(page.getByText('Done', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });
});
