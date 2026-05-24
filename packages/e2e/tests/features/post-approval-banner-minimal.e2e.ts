/**
 * Post-Approval Banner Minimal (single-line rule) E2E Tests
 *
 * Regression guard for the banner consolidation landed in PR 4/5 of
 * `remove-completion-actions-task-agent-as-post-approval-executor.md` (§4.7).
 *
 * The rules these tests enforce:
 *
 *   1. At most ONE banner renders above the task composer at any time
 *      (`[data-testid="task-blocked-banner"]`, `[data-testid="pending-gate-banner"]`,
 *      `[data-testid="pending-task-completion-banner"]`,
 *      `[data-testid="pending-post-approval-banner"]`). Never two at once.
 *   2. Whichever banner renders, its rendered height is a single line —
 *      i.e. no wrapping, no multi-line rationale inline. We assert a
 *      tight upper-bound on `boundingBox().height` to catch regressions
 *      that might add hidden `<p>` rows, stack traces, or rationale text.
 *
 * Setup / teardown infrastructure goes through RPC. All assertions are
 * through visible DOM state, per the E2E conventions in
 * `docs/conventions/e2e.md`.
 *
 * The cases exercised:
 *   - A task in `blocked` status with `blockReason: 'execution_failed'`
 *     renders the `TaskBlockedBanner` (red tone, Resume button).
 *   - A task in `blocked` status with `blockReason: 'human_input_requested'`
 *     renders the minimal "reply via composer" hint (amber tone, no CTA).
 *
 * More exotic states (`gate_pending`, `task_completion_pending`,
 * `post_approval_blocked`) require either a live workflow run with
 * scripted gates or a running post-approval session; those are covered
 * by the other `post-approval-*.e2e.ts` files and are intentionally not
 * duplicated here — this file's job is the one-line geometry guard.
 */

import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// The InlineStatusBanner primitive uses `px-2 py-1 text-xs` — ~24-28px total
// with the 1-line content. A multi-line regression would easily push this
// past 48px, so 44 is a safe upper bound that catches bloat without being
// brittle against minor spacing tweaks.
const SINGLE_LINE_MAX_HEIGHT_PX = 44;

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

interface Fixture {
  spaceId: string;
  taskId: string;
}

async function createBlockedTaskFixture(
  page: Page,
  blockReason: 'execution_failed' | 'human_input_requested'
): Promise<Fixture> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(
    workspaceRoot,
    `banner-minimal-${blockReason.replace(/_/g, '-')}`
  );

  return page.evaluate(
    async ({ wsPath, blockReason }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      const space = (await hub.request('space.create', {
        name: `E2E Banner Minimal ${Date.now()}`,
        workspacePath: wsPath,
      })) as { id: string };

      // Standalone task (no workflow run) so the gate-pending banner
      // path is unreachable — we want deterministic TaskBlockedBanner.
      const task = (await hub.request('spaceTask.create', {
        spaceId: space.id,
        title: 'Banner geometry probe',
        description: '',
      })) as { id: string };

      // Transition through in_progress so the `open → blocked` path is
      // legal. The blockReason is stamped alongside.
      await hub.request('spaceTask.update', {
        spaceId: space.id,
        taskId: task.id,
        status: 'in_progress',
      });
      await hub.request('spaceTask.update', {
        spaceId: space.id,
        taskId: task.id,
        status: 'blocked',
        blockReason,
        result: blockReason === 'execution_failed' ? 'Process exited with code 1' : null,
      });

      return { spaceId: space.id, taskId: task.id };
    },
    { wsPath, blockReason }
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

async function assertOneBanner(page: Page): Promise<void> {
  // Count banners with the well-known test IDs. Exactly one should be
  // present. We check each testid individually so the assertion message
  // tells us which pair conflicts on regression.
  const counts = await page.evaluate(() => {
    const q = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`).length;
    return {
      taskBlockedBanner: q('task-blocked-banner'),
      pendingGateBanner: q('pending-gate-banner'),
      pendingTaskCompletionBanner: q('pending-task-completion-banner'),
      pendingPostApprovalBanner: q('pending-post-approval-banner'),
    };
  });
  const total =
    counts.taskBlockedBanner +
    counts.pendingGateBanner +
    counts.pendingTaskCompletionBanner +
    counts.pendingPostApprovalBanner;
  expect(total, `expected exactly one banner, got: ${JSON.stringify(counts)}`).toBe(1);
}

async function assertBannerIsSingleLine(page: Page, testId: string): Promise<void> {
  const banner = page.getByTestId(testId);
  await expect(banner).toBeVisible({ timeout: 10000 });
  const box = await banner.boundingBox();
  expect(box, `banner ${testId} has no bounding box`).not.toBeNull();
  expect(
    box!.height,
    `banner ${testId} rendered ${box!.height}px tall — expected ≤ ${SINGLE_LINE_MAX_HEIGHT_PX}px`
  ).toBeLessThanOrEqual(SINGLE_LINE_MAX_HEIGHT_PX);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Post-approval banner minimal (single-line rule)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';

  test.afterEach(async ({ page }) => {
    if (spaceId) {
      await deleteSpace(page, spaceId);
      spaceId = '';
    }
  });

  test('execution_failed banner renders as a single-line red banner with a Resume button', async ({
    page,
  }) => {
    await page.goto('/');
    const fixture = await createBlockedTaskFixture(page, 'execution_failed');
    spaceId = fixture.spaceId;

    await page.goto(`/space/${fixture.spaceId}/task/${fixture.taskId}`);
    await page.waitForURL(`/space/${fixture.spaceId}/task/${fixture.taskId}`, { timeout: 10000 });

    // Exactly one banner — no double-rendering.
    await assertOneBanner(page);

    // The banner is TaskBlockedBanner with the red tone.
    const banner = page.getByTestId('task-blocked-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toHaveAttribute('data-tone', 'red');
    await expect(banner).toHaveAttribute('data-reason', 'execution_failed');

    // Resume is the primary action.
    await expect(page.getByTestId('task-resume-btn')).toBeVisible({ timeout: 5000 });

    // Height check — the big one.
    await assertBannerIsSingleLine(page, 'task-blocked-banner');
  });

  test('human_input_requested banner renders as a single-line "reply via composer" hint', async ({
    page,
  }) => {
    await page.goto('/');
    const fixture = await createBlockedTaskFixture(page, 'human_input_requested');
    spaceId = fixture.spaceId;

    await page.goto(`/space/${fixture.spaceId}/task/${fixture.taskId}`);
    await page.waitForURL(`/space/${fixture.spaceId}/task/${fixture.taskId}`, { timeout: 10000 });

    await assertOneBanner(page);

    const banner = page.getByTestId('task-blocked-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toHaveAttribute('data-reason', 'human_input_requested');

    // The minimal variant does NOT expose an inline CTA.
    await expect(page.getByTestId('task-resume-btn')).toBeHidden();
    await expect(page.getByTestId('gate-review-btn')).toBeHidden();

    await assertBannerIsSingleLine(page, 'task-blocked-banner');
  });
});
