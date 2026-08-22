import { test, expect } from '../../fixtures';
import type { Page } from '@playwright/test';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import { createUniqueSpaceDir } from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

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

      const task = (await hub.request('spaceTask.create', {
        spaceId: space.id,
        title: 'Standalone task with no workflow',
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
  } catch {}
}

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

    await expect(page.getByTestId('task-blocked-banner')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('pending-post-approval-banner')).toBeHidden({ timeout: 5000 });
    await expect(page.getByTestId('pending-task-completion-banner')).toBeHidden({ timeout: 5000 });
  });

  test('task status reflects approved (standalone tasks do not auto-transition to done)', async ({
    page,
  }) => {
    await page.goto('/');
    const fixture = await createStandaloneTaskInApproved(page);
    spaceId = fixture.spaceId;

    await page.goto(`/space/${fixture.spaceId}/task/${fixture.taskId}`);
    await page.waitForURL(`/space/${fixture.spaceId}/task/${fixture.taskId}`, { timeout: 10000 });

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
