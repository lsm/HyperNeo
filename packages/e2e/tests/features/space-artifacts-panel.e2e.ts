/**
 * Artifacts Side Panel E2E Tests (M7.4)
 *
 * Verifies that the artifacts panel in the SpaceTaskPane correctly shows
 * changed files for a workflow task:
 *   - "Artifacts" toggle button is visible on tasks with a workflowRunId
 *   - Clicking the toggle opens the artifacts panel
 *   - Panel lists changed files with +/- line counts
 *   - Clicking a file opens the FileDiffView with rendered diff
 *   - Back button returns to the file list
 *   - Close button hides the panel and restores the thread view
 *
 * Setup:
 *   - A unique workspace directory is created in beforeEach.
 *   - A git repo is initialised there with one commit and a staged change
 *     (feature.ts, 3 added lines) so getGateArtifacts returns real data.
 *   - Space + workflow run are created via RPC in beforeEach (infrastructure).
 *
 * Cleanup:
 *   - Workflow run is cancelled via RPC in afterEach.
 *   - Space is deleted via RPC in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, navigation, keyboard).
 *   - All assertions check visible DOM state.
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *
 * Timeout conventions:
 *   - 10000ms: server round-trips (store hydration, git diff fetch)
 *   - 5000ms:  local UI changes (button visibility, panel toggle)
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Git setup helper (Node.js side, called before space creation) ─────────────

/**
 * Initialise a git repository in `wsPath` with:
 *   1. An initial commit (base.txt)
 *   2. A staged new file (feature.ts, 3 additions)
 *
 * After this `git diff --numstat HEAD` returns `3\t0\tfeature.ts`, which is
 * exactly what getGateArtifacts uses for its diff summary.
 */
function setupGitRepoWithChanges(wsPath: string): void {
  execFileSync('git', ['init'], { cwd: wsPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@e2e.test'], { cwd: wsPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: wsPath, stdio: 'ignore' });

  // Initial commit
  writeFileSync(join(wsPath, 'base.txt'), 'initial content\n');
  execFileSync('git', ['add', 'base.txt'], { cwd: wsPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: wsPath, stdio: 'ignore' });

  // Stage a new file so git diff HEAD shows 3 additions for feature.ts
  writeFileSync(join(wsPath, 'feature.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  execFileSync('git', ['add', 'feature.ts'], { cwd: wsPath, stdio: 'ignore' });
}

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

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

  // Unique subdirectory — workspace_path has a UNIQUE constraint in the DB.
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'artifacts');

  // Set up git repo with staged file changes BEFORE creating the space.
  // getGateArtifacts uses space.workspacePath as the git working tree, so the
  // repo must already be initialised when the RPC is invoked from the UI.
  setupGitRepoWithChanges(wsPath);

  const ids = await page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Create space (preset agents + workflow are auto-seeded by the daemon).
      const spaceRes = (await hub.request('space.create', {
        name: `E2E Artifacts ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };
      const spaceId = spaceRes.id;

      // Start a workflow run — the daemon creates the first task automatically.
      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId,
        title: 'E2E: Artifacts panel test',
        description: 'Verify the artifacts side panel shows changed files.',
      })) as { run: { id: string } };
      const runId = runRes.run.id;

      // Find the task created by this run (it carries workflowRunId).
      const tasks = (await hub.request('spaceTask.list', { spaceId })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      const task = tasks.find((t) => t.workflowRunId === runId);
      if (!task) throw new Error(`No task found for run ${runId}`);
      const taskId = task.id;

      // Mark task as done to prevent the task agent from running — the runtime
      // skips terminal tasks, so no sub-sessions are created that would cause the
      // space store to reload and make SpaceIsland show a loading spinner during tests.
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
  } catch {
    // Best-effort cleanup
  }
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
  } catch {
    // Best-effort cleanup
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Artifacts Side Panel', () => {
  // Serial mode: tests share describe-scoped state (spaceId/runId/taskId) and
  // each beforeEach creates a new space. Running in parallel would race on the
  // same module-level variables and produce unpredictable failures.
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let runId = '';
  let taskId = '';
  let wsPath = ''; // tracked for cleanup in afterEach

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
    // Remove the unique workspace directory created for this test to avoid
    // accumulating orphaned directories across test runs.
    if (wsPath && existsSync(wsPath)) {
      try {
        rmSync(wsPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      wsPath = '';
    }
  });

  // ─── Test 1: Toggle button is visible for tasks with a workflowRunId ────

  test('artifacts toggle button is visible on tasks backed by a workflow run', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // The button only renders when task.workflowRunId is set.
    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
  });

  // ─── Test 2: Full happy-path — open panel, verify files, diff, close ────

  test('artifacts panel shows changed files with +/- line counts and diff view', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Wait for the Artifacts toggle (visible only when task.workflowRunId is set).
    const toggleBtn = page.getByTestId('artifacts-toggle');
    await expect(toggleBtn).toBeVisible({ timeout: 10000 });

    // Open the artifacts panel.
    await toggleBtn.click();

    // Panel container must appear.
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });

    // Wait for the async git diff fetch to complete.
    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    // Summary row: "N files changed", "+additions", "-deletions".
    await expect(page.getByTestId('artifacts-summary')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('artifacts-summary')).toContainText('file');

    // The staged feature.ts (3 additions) must be listed.
    await expect(page.getByTestId('artifacts-file-list')).toBeVisible({ timeout: 5000 });

    const fileRow = page
      .getByTestId('artifacts-file-row')
      .filter({ hasText: 'feature.ts' })
      .first();
    await expect(fileRow).toBeVisible({ timeout: 5000 });

    // Each file row shows "+N" additions and "-N" deletions.
    await expect(fileRow.locator('span.text-green-400').first()).toContainText('+');
    await expect(fileRow.locator('span.text-red-400').first()).toContainText('-');
  });

  // ─── Test 3: Clicking a file row opens the diff view ────────────────────

  test('clicking a file row opens the FileDiffView and back button returns to file list', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Open the panel.
    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('artifacts-toggle').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    // Ensure file list is present before clicking.
    await expect(page.getByTestId('artifacts-file-list')).toBeVisible({ timeout: 5000 });
    const fileRow = page
      .getByTestId('artifacts-file-row')
      .filter({ hasText: 'feature.ts' })
      .first();
    await expect(fileRow).toBeVisible({ timeout: 5000 });

    // Click the file to open the diff view.
    await fileRow.click();

    // FileDiffView must appear (replaces the file list in the same panel).
    await expect(page.getByTestId('file-diff-view')).toBeVisible({ timeout: 10000 });

    // Wait for the diff fetch to complete.
    await expect(page.getByTestId('diff-loading')).toBeHidden({ timeout: 10000 });

    // The diff fetch must not have failed.
    await expect(page.getByTestId('diff-error')).toBeHidden({ timeout: 5000 });

    // feature.ts was staged with 3 new lines, so the diff table must be present.
    // diff-empty would indicate git returned no output, which is a test setup failure.
    await expect(page.getByTestId('diff-table')).toBeVisible({ timeout: 5000 });

    // Back button returns to the file list.
    await page.getByTestId('file-diff-back').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('artifacts-file-list')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 4: Toggling the pill dismisses the panel ──────────────────────

  test('clicking the artifacts toggle while open dismisses the panel and restores the thread view', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Open the panel.
    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('artifacts-toggle').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });

    // The header (with its X button) was removed — clicking the artifacts
    // pill toggle a second time is now the canonical way to close the panel.
    await page.getByTestId('artifacts-toggle').click();

    // Panel must be gone and the task thread panel must be back.
    await expect(page.getByTestId('artifacts-panel')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 5: Summary line counts match the staged changes ────────────────

  test('artifacts summary shows correct file count and addition/deletion counts', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Open the panel.
    await expect(page.getByTestId('artifacts-toggle')).toBeVisible({ timeout: 10000 });
    await page.getByTestId('artifacts-toggle').click();
    await expect(page.getByTestId('artifacts-panel')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    const summary = page.getByTestId('artifacts-summary');
    await expect(summary).toBeVisible({ timeout: 5000 });

    // feature.ts has 3 added lines → summary shows "+3" additions.
    await expect(summary.locator('span.text-green-400')).toContainText('+3');
    // No deletions for a new file → "-0".
    await expect(summary.locator('span.text-red-400')).toContainText('-0');
    // One file changed.
    await expect(summary).toContainText('1 file');
  });
});
