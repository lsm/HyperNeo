import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

function setupGitRepoWithChanges(wsPath: string): void {
  execFileSync('git', ['init'], { cwd: wsPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@e2e.test'], { cwd: wsPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: wsPath, stdio: 'ignore' });

  writeFileSync(join(wsPath, 'base.txt'), 'initial content\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: wsPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: wsPath, stdio: 'ignore' });

  writeFileSync(join(wsPath, 'feature.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  execFileSync('git', ['add', 'feature.ts'], { cwd: wsPath, stdio: 'ignore' });
}

interface SpaceRunTask {
  spaceId: string;
  runId: string;
  taskId: string;
  wsPath: string;
}

async function createSpaceWithRunAndChanges(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<SpaceRunTask> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);

  const wsPath = createUniqueSpaceDir(workspaceRoot, 'artifacts');

  setupGitRepoWithChanges(wsPath);

  const ids = await page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const spaceRes = (await hub.request('space.create', {
        name: `E2E Artifacts ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };
      const spaceId = spaceRes.id;

      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId,
        title: 'E2E: Artifacts panel test',
        description: 'Verify the artifacts side panel shows changed files.',
      })) as { run: { id: string } };
      const runId = runRes.run.id;

      const tasks = (await hub.request('spaceTask.list', { spaceId })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      const task = tasks.find((t) => t.workflowRunId === runId);
      if (!task) throw new Error(`No task found for run ${runId}`);
      const taskId = task.id;

      await hub.request('spaceTask.update', { spaceId, taskId, status: 'done' });

      return { spaceId, runId, taskId };
    },
    { wsPath }
  );

  return { ...ids, wsPath };
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
  } catch {}
}

async function deleteSpace(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  spaceId: string
): Promise<void> {
  try {
    await page.evaluate(async (id) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('space.delete', { id });
    }, spaceId);
  } catch {}
}

test.describe('Artifacts Side Panel', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let runId = '';
  let taskId = '';
  let wsPath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ids = await createSpaceWithRunAndChanges(page);
    spaceId = ids.spaceId;
    runId = ids.runId;
    taskId = ids.taskId;
    wsPath = ids.wsPath;
  });

  test.afterEach(async ({ page }) => {
    if (runId) {
      await cancelRun(page, runId);
      runId = '';
    }
    if (spaceId) {
      await deleteSpace(page, spaceId);
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

  test('artifacts toggle button is visible on tasks backed by a workflow run', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
  });

  test('artifacts panel shows changed files with +/- line counts and diff view', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    const toggleBtn = page.getByTestId('artifacts-toggle');
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });

    await toggleBtn.click();

    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });

    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    await expect(page.getByTestId('artifacts-summary')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('artifacts-summary')).toContainText('file');

    await expect(page.getByTestId('artifacts-file-list')).toBeVisible({ timeout: 5000 });

    const fileRow = page
      .getByTestId('artifacts-file-row')
      .filter({ hasText: 'feature.ts' })
      .first();
    await expect(fileRow).toBeVisible({ timeout: 5000 });

    await expect(fileRow.locator('span.text-green-400').first()).toContainText('+');
    await expect(fileRow.locator('span.text-red-400').first()).toContainText('-');
  });

  test('clicking a file row opens the FileDiffView and back button returns to file list', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('artifacts-toggle').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    await expect(page.getByTestId('artifacts-file-list')).toBeVisible({ timeout: 5000 });
    const fileRow = page
      .getByTestId('artifacts-file-row')
      .filter({ hasText: 'feature.ts' })
      .first();
    await expect(fileRow).toBeVisible({ timeout: 5000 });

    await fileRow.click();

    await expect(page.getByTestId('file-diff-view')).toBeVisible({ timeout: 10000 });

    await expect(page.getByTestId('diff-loading')).toBeHidden({ timeout: 10000 });

    await expect(page.getByTestId('diff-error')).toBeHidden({ timeout: 5000 });

    await expect(page.getByTestId('diff-table')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('file-diff-back').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('artifacts-file-list')).toBeVisible({ timeout: 5000 });
  });

  test('clicking the artifacts toggle while open dismisses the panel and restores the thread view', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('artifacts-toggle').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });

    await page.getByTestId('artifacts-toggle').click();

    await expect(page.getByTestId('artifacts-panel')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
  });

  test('artifacts summary shows correct file count and addition/deletion counts', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('artifacts-toggle').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    const summary = page.getByTestId('artifacts-summary');
    await expect(summary).toBeVisible({ timeout: 5000 });

    await expect(summary.locator('span.text-green-400')).toContainText('+3');
    await expect(summary.locator('span.text-red-400')).toContainText('-0');
    await expect(summary).toContainText('1 file');
  });
});
