/**
 * Approval Gate Rejection E2E Tests (M8.3)
 *
 * Tests human rejection via the artifacts view and direct popup action:
 * - Proceeding to plan-approval-gate (waiting_human state at run start)
 * - Rejecting via GateArtifactsView (View Artifacts → Reject button)
 * - Rejecting directly from the gate popup (without opening artifacts)
 * - Workflow run transitions to needs_attention state on canvas
 * - Canvas shows "Workflow paused — awaiting approval" banner
 * - Gate shows blocked state (red lock icon)
 * - Space remains usable after rejection (tabs navigate, canvas visible)
 *
 * Setup:
 *   - Space is created via RPC in beforeEach (infrastructure).
 *   - Workflow run is started via RPC in beforeEach (infrastructure).
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
 * Note: The plan-approval-gate is ALWAYS in `waiting_human` state at the start of a run
 * because its condition is `{ type: 'check', field: 'approved' }` and no gate data has
 * been written yet. Rejection sets approved=false → gate becomes `blocked`, and the run
 * transitions to `needs_attention` with failureReason `humanRejected`.
 *
 * Timeout conventions:
 *   - 30000ms: canvas/SVG and gate-icon visibility (workflow data from live query may be slow under load)
 *   - 10000ms: server round-trips that don't need canvas-level wait (gate data load, run status)
 *   - 5000ms: UI-only changes (popup visibility, overlay open/close, tab content)
 */

import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

async function createSpaceWithRun(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<{ spaceId: string; runId: string; taskId: string }> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  // Use a unique subdirectory to avoid conflicts with other parallel tests
  // (workspace_path has a UNIQUE constraint in the DB).
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'gate-rejection');

  return page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Create the space (preset agents + workflow are auto-seeded by the daemon).
      const spaceRes = (await hub.request('space.create', {
        name: `E2E Rejection ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };
      const spaceId = spaceRes.id;

      // Start a workflow run so the canvas enters runtime mode.
      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId,
        title: 'E2E: Rejection test task',
        description: 'Implement a feature to test rejection flow.',
      })) as { run: { id: string } };
      const runId = runRes.run.id;

      // Find the task created for this run.
      const tasks = (await hub.request('spaceTask.list', { spaceId })) as Array<{
        id: string;
        workflowRunId?: string;
      }>;
      const task = tasks.find((t) => t.workflowRunId === runId);
      if (!task) throw new Error(`No task found for run ${runId}`);
      const taskId = task.id;

      // Mark the task as done to prevent the task agent from running — the runtime
      // skips terminal tasks, so no sub-sessions are created that would cause the
      // space store to reload and disturb canvas assertions.
      await hub.request('spaceTask.update', { spaceId, taskId, status: 'done' });

      return { spaceId, runId, taskId };
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

// ─── UI action helpers ────────────────────────────────────────────────────────

/**
 * Waits for the canvas to be fully initialized (SVG rendered + gate data loaded),
 * then rejects the waiting_human gate via the action popup.
 * Resolves once the gate-icon-blocked state is visible on the canvas.
 */
async function rejectViaPopup(page: Page): Promise<void> {
  // Wait for canvas to be in runtime mode with gate data fetched.
  // Both the container and SVG must be visible before gate icons appear.
  // Use 30s timeout — workflow data from the store (live query) may load slowly under load.
  await expect(page.getByTestId('canvas-view').getByTestId('workflow-canvas')).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
    timeout: 30000,
  });

  // Gate data is fetched async after canvas renders; wait for the gate icon.
  const waitingGate = page.getByTestId('canvas-view').getByTestId('gate-icon-waiting_human');
  await expect(waitingGate).toBeVisible({ timeout: 30000 });

  // Open the action popup.
  // The gate icon is an SVG <g> element with animate-pulse applied when in waiting_human
  // state, which causes Playwright's stability checks to time out. Use force:true to bypass
  // the actionability checks and click immediately.
  await waitingGate.click({ force: true });
  await expect(page.getByTestId('popup-reject-btn')).toBeVisible({ timeout: 5000 });

  // Click Reject in the popup.
  await page.getByTestId('popup-reject-btn').click();

  // Wait for the server round-trip: run transitions to needs_attention + gate becomes blocked.
  // Use data-gate-id to target the specific plan-approval-gate — after rejection ALL gates
  // may show as blocked (run enters blocked status), causing strict mode violations.
  // Use 30s timeout — the space store may briefly reload after rejection, causing canvas-view
  // to temporarily disappear and reappear once the space data is fetched again.
  await expect(
    page
      .getByTestId('canvas-view')
      .locator('[data-gate-id="plan-approval-gate"][data-testid="gate-icon-blocked"]')
  ).toBeVisible({
    timeout: 30000,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Approval Gate Rejection', () => {
  // Run tests sequentially to avoid overloading the server with parallel task-agent
  // SDK startup timeouts — parallel execution caused tests 1-2 to time out waiting
  // for the gate-icon-waiting_human to appear on the canvas.
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let runId = '';
  let taskId = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ids = await createSpaceWithRun(page);
    spaceId = ids.spaceId;
    runId = ids.runId;
    taskId = ids.taskId;
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
  });

  // ─── Test 1: Reject via GateArtifactsView closes overlay and transitions run ──

  test('rejecting via GateArtifactsView closes overlay and transitions run to needs_attention', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    // Wait for canvas to be fully initialized (container + SVG + gate data).
    // Use 30s here — the canvas panel requires workflow data from the store (live query),
    // which may take longer when the server is under load at test start.
    await expect(page.getByTestId('canvas-view').getByTestId('workflow-canvas')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
      timeout: 30000,
    });

    // The plan-approval-gate starts in waiting_human (amber pulsing).
    const waitingGate = page.getByTestId('canvas-view').getByTestId('gate-icon-waiting_human');
    await expect(waitingGate).toBeVisible({ timeout: 30000 });

    // Open the action popup.
    // The gate icon is an SVG <g> element with animate-pulse applied when in waiting_human
    // state, which causes Playwright's stability checks to time out. Use force:true to bypass
    // the actionability checks and click immediately.
    await waitingGate.click({ force: true });
    await expect(page.getByTestId('view-artifacts-btn')).toBeVisible({ timeout: 5000 });

    // Open the artifacts overlay.
    await page.getByTestId('view-artifacts-btn').click();
    await expect(page.getByTestId('artifacts-panel-overlay')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('gate-artifacts-view')).toBeVisible({ timeout: 5000 });

    // Wait for the loading state to resolve before clicking Reject.
    await expect(page.getByTestId('artifacts-loading')).toBeHidden({ timeout: 10000 });

    // Click Reject.
    await page.getByTestId('reject-button').click();

    // Overlay should close after the rejection decision.
    await expect(page.getByTestId('artifacts-panel-overlay')).toBeHidden({ timeout: 15000 });

    // The gate should now show as "blocked" (red lock) on the canvas.
    // Use 30s — the space store may briefly reload after rejection, causing canvas-view
    // to temporarily disappear and reappear once the space data is fetched again.
    await expect(
      page
        .getByTestId('canvas-view')
        .locator('[data-gate-id="plan-approval-gate"][data-testid="gate-icon-blocked"]')
    ).toBeVisible({
      timeout: 30000,
    });

    // Canvas banner: "Workflow paused — awaiting approval" (run.failureReason === 'humanRejected').
    await expect(
      page.getByTestId('canvas-view').locator('text=Workflow paused — awaiting approval')
    ).toBeVisible({
      timeout: 10000,
    });
  });

  // ─── Test 2: Reject directly from gate popup without opening artifacts ────

  test('rejecting directly from gate popup sets gate to blocked without opening overlay', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    await rejectViaPopup(page);

    // Overlay must NOT have appeared (we never opened it).
    await expect(page.getByTestId('artifacts-panel-overlay')).toBeHidden({ timeout: 5000 });

    // Canvas banner should indicate needs_attention.
    await expect(
      page.getByTestId('canvas-view').locator('text=Workflow paused — awaiting approval')
    ).toBeVisible({
      timeout: 10000,
    });
  });

  // ─── Test 3: Canvas shows error/attention state after rejection ───────────

  test('canvas shows needs_attention banner and blocked gate after rejection', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    await rejectViaPopup(page);

    // Canvas shows the needs_attention banner.
    await expect(
      page.getByTestId('canvas-view').locator('text=Workflow paused — awaiting approval')
    ).toBeVisible({
      timeout: 5000,
    });

    // The canvas container and SVG are still present (not replaced by an error fallback).
    await expect(page.getByTestId('canvas-view').getByTestId('workflow-canvas')).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
      timeout: 5000,
    });
  });

  // ─── Test 4: Space remains usable after rejection ─────────────────────────

  test('space remains fully navigable and usable after gate rejection', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    await rejectViaPopup(page);

    // Verify canvas still renders with the blocked gate after rejection.
    await expect(page.getByTestId('canvas-view').getByTestId('workflow-canvas')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page
        .getByTestId('canvas-view')
        .locator('[data-gate-id="plan-approval-gate"][data-testid="gate-icon-blocked"]')
    ).toBeVisible({
      timeout: 10000,
    });

    // Space configure page should still be navigable — clicking Agents shows agent content.
    // SpaceAgentList does NOT depend on spaceStore.space being non-null (unlike
    // WorkflowList / SpaceSettings), so it's a more reliable navigation target.
    await page.goto(`/space/${spaceId}/configure`);
    await page.waitForURL(`/space/${spaceId}/configure`, { timeout: 10000 });
    await page.getByTestId('space-configure-tab-agents').click();
    await expect(page.locator('text=Planner')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=Coder')).toBeVisible({ timeout: 10000 });

    // Return to task canvas — canvas should still be visible with the blocked state.
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();
    await expect(page.getByTestId('canvas-view').getByTestId('workflow-canvas')).toBeVisible({
      timeout: 30000,
    });
    await expect(
      page
        .getByTestId('canvas-view')
        .locator('[data-gate-id="plan-approval-gate"][data-testid="gate-icon-blocked"]')
    ).toBeVisible({
      timeout: 10000,
    });
  });

  // ─── Test 5: Rejected gate shows blocked state on canvas ─────────────────

  test('rejected gate icon transitions from waiting_human (amber) to blocked (red lock)', async ({
    page,
  }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });
    await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
    await page.getByTestId('canvas-toggle').click();

    // Initially: amber waiting_human gate is visible.
    await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.getByTestId('canvas-view').getByTestId('gate-icon-waiting_human')
    ).toBeVisible({ timeout: 10000 });

    await rejectViaPopup(page);

    // After rejection: blocked gate is visible.
    await expect(
      page
        .getByTestId('canvas-view')
        .locator('[data-gate-id="plan-approval-gate"][data-testid="gate-icon-blocked"]')
    ).toBeVisible({
      timeout: 10000,
    });

    // The waiting_human gate should no longer be visible.
    // Assumption: FULL_CYCLE_CODING_WORKFLOW has exactly one human-approval gate in the
    // pre-coding phase (plan-approval-gate). If the workflow adds more human gates
    // in the future, this assertion would need revisiting — but for the current
    // template it confirms the gate correctly transitioned away from waiting_human.
    await expect(page.getByTestId('canvas-view').getByTestId('gate-icon-waiting_human')).toBeHidden(
      { timeout: 10000 }
    );
  });
});
