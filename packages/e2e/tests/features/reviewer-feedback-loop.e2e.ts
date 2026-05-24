/**
 * Reviewer Feedback Loop E2E Tests (M8.2)
 *
 * Tests that verify the canvas correctly visualizes:
 * 1. Reviewer rejection — review-reject-gate shows open (green) when a reviewer rejects
 * 2. Coder re-activation — Coding node shows active (blue pulsing) after re-activation
 * 3. review-votes-gate vote display — "N/M" badge shows correct partial/full vote counts
 * 4. All 3 reviewers approve — review-votes-gate opens (green) when min is met
 * 5. QA and Done pipeline — qa-result-gate opens after QA passes
 * 6. State transition: inject rejection then approval votes in sequence
 *
 * Setup strategy (per test):
 *   - Space + run created via RPC in beforeEach (infrastructure)
 *   - Gate data injected via `spaceWorkflowRun.writeGateData` RPC (infrastructure)
 *   - For "Coding active" test: node execution created as in_progress via RPC (infrastructure)
 *   - All assertions verify visible DOM state only
 *
 * Cleanup:
 *   - Run cancelled + space deleted in afterEach (infrastructure)
 *
 * E2E Rules:
 *   - All test actions go through the UI (navigation, assertions on visible DOM)
 *   - RPC is used only in beforeEach / afterEach for infrastructure setup / teardown
 *
 * Isolation:
 *   - test.describe.serial forces sequential execution to avoid workspace path conflicts
 */

import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure types ─────────────────────────────────────────────────────

interface SpaceRunIds {
  spaceId: string;
  runId: string;
  taskId: string;
}

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

async function createSpaceWithRun(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<SpaceRunIds> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);

  return page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Clean up any leftover space at this workspace path (including archived).
      const norm = (p: string) => p.replace(/^\/private/, '');
      try {
        const list = (await hub.request('space.list', { includeArchived: true })) as Array<{
          id: string;
          workspacePath: string;
        }>;
        const matches = list.filter((s) => norm(s.workspacePath) === norm(wsPath));
        for (const s of matches) {
          await hub.request('space.delete', { id: s.id });
        }
      } catch {
        // Ignore cleanup errors
      }

      const spaceRes = (await hub.request('space.create', {
        name: `E2E Reviewer Loop ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };
      const spaceId = spaceRes.id;

      const runRes = (await hub.request('spaceWorkflowRun.start', {
        spaceId,
        title: 'E2E: Reviewer feedback loop test',
        description: 'Test task for reviewer feedback loop E2E test.',
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
    { wsPath: workspaceRoot }
  );
}

/**
 * Navigate to a space task and open the canvas view.
 *
 * page.goto() causes a full reload, which can briefly disconnect MessageHub transport.
 * Waiting for reconnection prevents flaky follow-up assertions that depend on live data.
 * The canvas is only accessible from the task pane — navigate to task URL and click the toggle.
 */
async function gotoSpaceAndWait(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  spaceId: string,
  taskId: string
): Promise<void> {
  await page.goto(`/space/${spaceId}/task/${taskId}`);
  await waitForWebSocketConnected(page);
  await page.waitForSelector('[data-testid="canvas-toggle"]', { timeout: 10000 });
  await page.getByTestId('canvas-toggle').click();
}

async function writeGateData(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  runId: string,
  gateId: string,
  data: Record<string, unknown>
): Promise<void> {
  await page.evaluate(
    async ({ rid, gid, d }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');
      // skipChannelRouting: true prevents the channel router from being triggered,
      // which for cyclic gates with resetOnCycle: true would immediately wipe the
      // gate data we just wrote (the router activates the downstream node, which
      // increments the cycle counter and resets cyclic gate data). E2E tests only
      // need the gate data visible on the canvas — they don't need node activation.
      await hub.request('spaceWorkflowRun.writeGateData', {
        runId: rid,
        gateId: gid,
        data: d,
        skipChannelRouting: true,
      });
    },
    { rid: runId, gid: gateId, d: data }
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

// ─── Get the Coding workflow node UUID ────────────────────────────────────────

async function getCodingNodeId(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  spaceId: string,
  runId: string
): Promise<string> {
  return page.evaluate(
    async ({ sid, rid }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const run = (await hub.request('spaceWorkflowRun.get', { id: rid })) as {
        run: { workflowId: string };
      };
      const workflow = (await hub.request('spaceWorkflow.get', {
        spaceId: sid,
        id: run.run.workflowId,
      })) as { workflow: { nodes: Array<{ id: string; name: string }> } };

      const codingNode = workflow.workflow.nodes.find((n) => n.name === 'Coding');
      if (!codingNode) throw new Error('Coding node not found in workflow');
      return codingNode.id;
    },
    { sid: spaceId, rid: runId }
  );
}

// ─── Create an in_progress node execution for a specific workflow node ───────

async function createActiveNodeExecution(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  runId: string,
  nodeId: string,
  agentName: string
): Promise<string> {
  return page.evaluate(
    async ({ rid, nid, aname }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const result = (await hub.request('nodeExecution.create', {
        workflowRunId: rid,
        workflowNodeId: nid,
        agentName: aname,
        status: 'in_progress',
      })) as { execution: { id: string } };

      return result.execution.id;
    },
    { rid: runId, nid: nodeId, aname: agentName }
  );
}

// ─── Selector helpers ─────────────────────────────────────────────────────────

/** Returns a locator for a gate icon with a specific gate ID and status. */
function gateIcon(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  gateId: string,
  status: 'open' | 'blocked' | 'waiting_human'
) {
  return page
    .getByTestId('canvas-view')
    .locator(`[data-testid="gate-icon-${status}"][data-gate-id="${gateId}"]`);
}

/** Returns a locator for the vote-count badge scoped to a specific gate. */
function voteBadge(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  gateId: string,
  text: string
) {
  return page
    .getByTestId('canvas-view')
    .locator(`[data-gate-id="${gateId}"] [data-testid="gate-vote-count"]:has-text("${text}")`)
    .first();
}

// ─── Test suites ──────────────────────────────────────────────────────────────

// serial: prevent parallel workers from racing on the shared workspace path
test.describe
  .serial('Space Reviewer Feedback Loop', () => {
    test.use({ viewport: DESKTOP_VIEWPORT });

    // ── 1. Reviewer rejection visible on canvas ──────────────────────────────
    test.describe('reviewer rejection state', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        // Write code-pr-gate to unblock reviewers, then write a rejection vote to review-votes-gate.
        // review-votes-gate requires count('approved') >= 3; a rejection vote adds 0 approvals.
        await writeGateData(page, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/test/repo/pull/1',
        });
        await writeGateData(page, runId, 'review-votes-gate', {
          votes: { 'Reviewer 1': 'rejected' },
        });
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
      });

      test('review-votes-gate stays blocked when one reviewer rejects', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // review-votes-gate requires 3 approvals; 1 rejection = 0 approvals → gate blocked
        await expect(gateIcon(page, 'review-votes-gate', 'blocked')).toBeVisible({
          timeout: 30000,
        });
      });

      test('review-votes-gate vote count badge shows 0/3 when one reviewer rejects', async ({
        page,
      }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // 1 rejection vote → 0 approved entries → badge shows "0/3"
        await expect(voteBadge(page, 'review-votes-gate', '0/3')).toBeVisible({ timeout: 30000 });
      });
    });

    // ── 2. Coder re-activation visible ────────────────────────────────────────
    test.describe('coder re-activation state', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';
      let codingNodeId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        // Get the Coding node UUID so we can create a node execution for it
        codingNodeId = await getCodingNodeId(page, spaceId, runId);

        // Create an in_progress node execution for the Coding node
        await createActiveNodeExecution(page, runId, codingNodeId, 'Coding');
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
        codingNodeId = '';
      });

      test('Coding node shows active (blue pulsing) after re-activation', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // The Coding node with in_progress execution renders with animate-pulse class.
        // Use text-based locator since WorkflowNode testids use localId (slug), not UUID.
        const codingNodeEl = page
          .getByTestId('canvas-view')
          .locator('[data-testid^="workflow-node-"]:has-text("Coding")');
        await expect(codingNodeEl).toBeVisible({ timeout: 30000 });

        // Active nodes have animate-pulse CSS class.
        // Allow extra time for the initial fetchNodeExecutions() call during space load.
        await expect(codingNodeEl).toHaveClass(/animate-pulse/, { timeout: 15000 });
      });
    });

    // ── 3. review-votes-gate partial vote count ───────────────────────────────
    test.describe('partial review votes (2 of 3 approved)', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        await writeGateData(page, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/test/repo/pull/1',
        });
        // 2 out of 3 reviewers approved
        await writeGateData(page, runId, 'review-votes-gate', {
          votes: { 'Reviewer 1': 'approved', 'Reviewer 2': 'approved' },
        });
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
      });

      test('review-votes-gate remains blocked (2/3 not enough to open)', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // 2 approvals < 3 required → review-votes-gate stays blocked (gray lock)
        await expect(gateIcon(page, 'review-votes-gate', 'blocked')).toBeVisible({
          timeout: 30000,
        });
      });

      test('review-votes-gate vote count badge shows 2/3', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // review-votes-gate has 3 channels sharing it (Reviewer 1/2/3 → QA)
        // Each shows the same "2/3" badge — expect at least one
        await expect(voteBadge(page, 'review-votes-gate', '2/3')).toBeVisible({ timeout: 30000 });
      });
    });

    // ── 4. All 3 reviewers approve ────────────────────────────────────────────
    test.describe('all reviewers approved (3 of 3)', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        await writeGateData(page, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/test/repo/pull/1',
        });
        await writeGateData(page, runId, 'review-votes-gate', {
          votes: {
            'Reviewer 1': 'approved',
            'Reviewer 2': 'approved',
            'Reviewer 3': 'approved',
          },
        });
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
      });

      test('review-votes-gate shows open (green) when all 3 reviewers approve', async ({
        page,
      }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // 3 approvals >= 3 required → review-votes-gate opens
        await expect(gateIcon(page, 'review-votes-gate', 'open')).toBeVisible({ timeout: 30000 });
      });

      test('review-votes-gate vote count badge shows 3/3', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        await expect(voteBadge(page, 'review-votes-gate', '3/3')).toBeVisible({ timeout: 30000 });
      });
    });

    // ── 5. All gates open — pipeline fully approved through to QA ────────────
    test.describe('all gates open — full pipeline approved', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        // Write all gates to simulate a fully approved state (3/3 code reviewers)
        await writeGateData(page, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/test/repo/pull/1',
        });
        await writeGateData(page, runId, 'review-votes-gate', {
          votes: {
            'Reviewer 1': 'approved',
            'Reviewer 2': 'approved',
            'Reviewer 3': 'approved',
          },
        });
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
      });

      test('review-votes-gate opens when all 3 reviewers approve (full pipeline)', async ({
        page,
      }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // 3 approvals >= 3 min → review-votes-gate opens → green checkmark on Code Review → QA channel
        await expect(gateIcon(page, 'review-votes-gate', 'open')).toBeVisible({ timeout: 30000 });
      });

      test('canvas shows all three Reviewer nodes and QA (pipeline tail)', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // All key nodes in the reviewer→QA pipeline must be visible
        await expect(page.locator('text=Reviewer 1')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=Reviewer 2')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=Reviewer 3')).toBeVisible({ timeout: 5000 });
        await expect(
          page.locator('[data-testid="step-name"]').filter({ hasText: 'QA' }).first()
        ).toBeVisible({ timeout: 5000 });
      });
    });

    // ── 6. vote reset after cycle (votes cleared) ─────────────────────────────
    test.describe('review-votes-gate reset after rejection cycle', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        // Simulate state AFTER a rejection cycle: code-pr-gate persists (resetOnCycle: false),
        // review-votes-gate has been cleared (resetOnCycle: true) — no votes written.
        await writeGateData(page, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/test/repo/pull/1',
        });
        // review-votes-gate is intentionally empty (reset state) — we don't write it
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
      });

      test('review-votes-gate shows 0/3 after votes are reset (empty)', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);

        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // With no votes written, the review-votes-gate shows 0/3
        await expect(voteBadge(page, 'review-votes-gate', '0/3')).toBeVisible({ timeout: 30000 });
      });
    });

    // ── 7. State transition: rejection → re-approval (feedback loop cycle) ────
    test.describe('rejection-to-approval state transition', () => {
      let spaceId = '';
      let runId = '';
      let taskId = '';

      test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const ids = await createSpaceWithRun(page);
        spaceId = ids.spaceId;
        runId = ids.runId;
        taskId = ids.taskId;

        await writeGateData(page, runId, 'code-pr-gate', {
          pr_url: 'https://github.com/test/repo/pull/1',
        });
      });

      test.afterEach(async ({ page }) => {
        if (runId) await cancelRun(page, runId);
        if (spaceId) await deleteSpace(page, spaceId);
        spaceId = '';
        runId = '';
        taskId = '';
      });

      test('canvas updates from rejection to full approval in sequence', async ({ page }) => {
        await gotoSpaceAndWait(page, spaceId, taskId);
        await expect(page.getByTestId('canvas-view').getByTestId('visual-canvas-svg')).toBeVisible({
          timeout: 30000,
        });

        // Step 1: Reviewer 1 rejects — review-votes-gate stays blocked (0 approvals < 3)
        await writeGateData(page, runId, 'review-votes-gate', {
          votes: { 'Reviewer 1': 'rejected' },
        });
        await expect(gateIcon(page, 'review-votes-gate', 'blocked')).toBeVisible({
          timeout: 30000,
        });

        // Step 2: After cycle reset — votes cleared, badge shows 0/3
        await writeGateData(page, runId, 'review-votes-gate', { votes: {} });
        await expect(voteBadge(page, 'review-votes-gate', '0/3')).toBeVisible({ timeout: 30000 });

        // Step 3: All 3 reviewers approve the revised code
        await writeGateData(page, runId, 'review-votes-gate', {
          votes: {
            'Reviewer 1': 'approved',
            'Reviewer 2': 'approved',
            'Reviewer 3': 'approved',
          },
        });
        await expect(gateIcon(page, 'review-votes-gate', 'open')).toBeVisible({
          timeout: 30000,
        });
        await expect(voteBadge(page, 'review-votes-gate', '3/3')).toBeVisible({ timeout: 30000 });
      });
    });
  });
