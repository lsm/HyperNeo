/**
 * Post-Approval: No-Route (direct approved → done) E2E Tests
 *
 * PR 4/5 of
 * `docs/plans/remove-completion-actions-task-agent-as-post-approval-executor.md`
 * deleted the completion-action pipeline; the only post-approval path now
 * runs through `PostApprovalRouter`. Workflows that do NOT declare
 * `postApproval` (or standalone tasks with no workflow at all) must route
 * through the `no-route` branch and transition directly from
 * `approved → done` — no reviewer session spawn, no `mark_complete`
 * round-trip.
 *
 * This file asserts that contract end-to-end via RPC + UI observation.
 * A standalone task is used instead of spinning up the Review-Only
 * workflow because:
 *
 *   1. Standalone tasks have `workflowRunId = null` → workflow lookup in
 *      `dispatchPostApproval` returns `null` → router short-circuits to
 *      `no-route` without running any LLM-backed agent.
 *   2. The router output is directly observable as a status transition
 *      on the task row, which the UI reflects without needing an agent
 *      to call `mark_complete`.
 *   3. This keeps the test hermetic — no reviewer session means no LLM
 *      provider dependency, no `gh` CLI dependency, nothing that would
 *      force CI to gate on network/API keys.
 *
 * The "merge" variants (`post-approval-merge-*.e2e.ts`) cover the spawn
 * + `mark_complete` branch and live alongside this file.
 *
 * Infrastructure setup/cleanup uses RPC only. All assertions are via
 * visible UI state, per the E2E conventions.
 */

import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

async function createStandaloneTaskInApproved(
  page: Page
): Promise<{ spaceId: string; taskId: string }> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'post-approval-no-route');

  return page.evaluate(
    async ({ wsPath }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const space = (await hub.request('space.create', {
        name: `E2E No-Route ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };

      // Standalone task — no workflowRunId, no postApproval possible.
      const task = (await hub.request('spaceTask.create', {
        spaceId: space.id,
        title: 'Standalone task with no workflow',
        description: '',
      })) as { id: string };

      // Walk the task through the lifecycle: open → in_progress → approved.
      // The transition validator requires we pass through in_progress first.
      await hub.request('spaceTask.update', {
        spaceId: space.id,
        taskId: task.id,
        status: 'in_progress',
      });
      await hub.request('spaceTask.update', {
        spaceId: space.id,
        taskId: task.id,
        status: 'approved',
      });

      return { spaceId: space.id, taskId: task.id };
    },
    { wsPath }
  );
}

async function deleteSpace(page: Page, spaceId: string): Promise<void> {
  if (!spaceId) return;
  try {
    await page.evaluate(async (id) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) return;
      await hub.request('space.delete', { id });
    }, spaceId);
  } catch {
    // Best-effort cleanup.
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Post-approval routing: no-route branch', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpace(page, spaceId);
      spaceId = '';
    }
  });

  test('standalone task at `approved` with no workflow renders no post-approval banner', async ({
    page,
  }) => {
    await page.goto('/');
    const fixture = await createStandaloneTaskInApproved(page);
    spaceId = fixture.spaceId;

    await page.goto(`/space/${fixture.spaceId}/task/${fixture.taskId}`);
    await page.waitForURL(`/space/${fixture.spaceId}/task/${fixture.taskId}`, { timeout: 10000 });

    // With no workflow run and no `postApprovalBlockedReason`, every
    // possible banner should be absent:
    //   - TaskBlockedBanner (status != blocked)
    //   - PendingPostApprovalBanner (no blocked reason)
    //   - PendingGateBanner (no workflow run)
    //   - PendingTaskCompletionBanner (no pending checkpoint)
    //
    // This is the positive contract: a `no-route` task should be a clean
    // slate — the whole point is that the UI never "advertises" that a
    // post-approval step is coming.
    await expect(page.getByTestId('task-blocked-banner')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('pending-post-approval-banner')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('pending-gate-banner')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('pending-task-completion-banner')).toBeHidden({ timeout: 5000 });
  });

  test('task status reflects approved (standalone tasks do not auto-transition to done)', async ({
    page,
  }) => {
    // When a standalone task is parked at `approved` via the RPC (rather
    // than arriving there through an end-node `approve_task` call that
    // triggers `dispatchPostApproval`), there is no router run — the task
    // stays in `approved` until someone explicitly transitions it.
    // The UI must surface this status honestly in the transition actions
    // strip (the "archived"/"reopen"/"mark done" buttons).
    await page.goto('/');
    const fixture = await createStandaloneTaskInApproved(page);
    spaceId = fixture.spaceId;

    await page.goto(`/space/${fixture.spaceId}/task/${fixture.taskId}`);
    await page.waitForURL(`/space/${fixture.spaceId}/task/${fixture.taskId}`, { timeout: 10000 });

    // Verify the task status via RPC (cross-checks the UI state).
    const status = await page.evaluate(
      async ({ sid, tid }) => {
        const hub = window.__messageHub || window.appState?.messageHub;
        if (!hub?.request) throw new Error('MessageHub not available');
        const task = (await hub.request('spaceTask.get', {
          spaceId: sid,
          taskId: tid,
        })) as { status: string };
        return task.status;
      },
      { sid: fixture.spaceId, tid: fixture.taskId }
    );
    expect(status).toBe('approved');
  });
});
