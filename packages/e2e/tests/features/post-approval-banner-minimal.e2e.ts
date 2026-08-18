import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

const SINGLE_LINE_MAX_HEIGHT_PX = 44;

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

      const task = (await hub.request('spaceTask.create', {
        spaceId: space.id,
        title: 'Banner geometry probe',
        description: '',
      })) as { id: string };

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

    await assertOneBanner(page);

    const banner = page.getByTestId('task-blocked-banner');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toHaveAttribute('data-tone', 'red');
    await expect(banner).toHaveAttribute('data-reason', 'execution_failed');

    await expect(page.getByTestId('task-resume-btn')).toBeVisible({ timeout: 5000 });

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

    await expect(page.getByTestId('task-resume-btn')).toBeHidden();
    await expect(page.getByTestId('gate-review-btn')).toBeHidden();

    await assertBannerIsSingleLine(page, 'task-blocked-banner');
  });
});
