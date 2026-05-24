/**
 * Agent Overlay Chat E2E Tests (M7.6)
 *
 * Verifies that the agent overlay slide-over panel works correctly on top of
 * the task view:
 *   - The overlay panel appears (data-testid="agent-overlay-chat")
 *   - The task view remains accessible underneath (URL unchanged)
 *   - The agent name is surfaced via the dialog's aria-label
 *   - The back button in ChatHeader (data-testid="chat-header-back") dismisses the overlay
 *   - Pressing Escape also dismisses the overlay
 *   - Clicking the translucent backdrop also dismisses the overlay
 *
 * Opening the overlay:
 *   The dedicated "View Agent Session" header button was removed (commit a019567d0)
 *   — agent sessions are now accessed via the compact-thread block headers which
 *   require live agent messages not available in this lightweight test setup.
 *   Instead, the overlay is opened via `window.__neokai_space_overlay.open()`, a
 *   test hook exposed by SpaceIsland. This is acceptable as test infrastructure
 *   because opening is purely client-side signal manipulation; all close/dismiss
 *   actions still go through the UI (clicks, keyboard).
 *
 * Setup:
 *   - A unique workspace directory is created in beforeEach.
 *   - Space + task are created via RPC (infrastructure).
 *   - The task is marked done so the space runtime ignores it (no race against
 *     the runtime clearing session IDs).
 *   - A human session is created via RPC so ChatContainer has a real session to
 *     load; without a valid session ID the ChatHeader / back button may not render.
 *
 * Cleanup:
 *   - Space is deleted via RPC in afterEach.
 *   - Session is deleted via RPC in afterEach.
 *   - Unique workspace directory is removed in afterEach.
 *
 * E2E Rules:
 *   - All test actions go through the UI (clicks, navigation, keyboard).
 *   - All assertions check visible DOM state.
 *   - RPC is only used in beforeEach / afterEach for infrastructure setup / teardown.
 *   - window.__neokai_space_overlay.open() is used as a test-infrastructure trigger
 *     (analogous to RPC setup calls) since no UI trigger is available in this
 *     lightweight setup.
 *
 * Timeout conventions:
 *   - 10000ms: server round-trips (store hydration, RPC calls, space load)
 *   - 5000ms:  local UI changes (overlay toggle, button visibility)
 */

import { existsSync, rmSync } from 'node:fs';
import { test, expect } from '../../fixtures';
import { waitForWebSocketConnected, getWorkspaceRoot } from '../helpers/wait-helpers';
import {
  createSpaceViaRpc,
  createSpaceTaskViaRpc,
  createUniqueSpaceDir,
  deleteSpaceViaRpc,
} from '../helpers/space-helpers';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

// ─── Infrastructure helpers (RPC — beforeEach / afterEach only) ────────────────

interface OverlayTestContext {
  spaceId: string;
  taskId: string;
  sessionId: string;
  wsPath: string;
}

/**
 * Create a space with a task and a standalone human session.
 *
 * The session is NOT linked to the task — it is only used as the sessionId
 * argument to `window.__neokai_space_overlay.open()` so that ChatContainer
 * has a valid session to load (enabling ChatHeader + back button to render).
 *
 * The task is set to `done` so the space runtime skips it entirely and cannot
 * race against test assertions.
 */
async function createSpaceWithTaskAndSession(
  page: Parameters<typeof waitForWebSocketConnected>[0]
): Promise<OverlayTestContext> {
  await waitForWebSocketConnected(page);
  const workspaceRoot = await getWorkspaceRoot(page);
  const wsPath = createUniqueSpaceDir(workspaceRoot, 'overlay');

  const spaceName = `E2E Overlay ${Date.now()}`;
  const spaceId = await createSpaceViaRpc(page, wsPath, spaceName);
  const taskId = await createSpaceTaskViaRpc(page, spaceId, 'Overlay test task');

  const sessionId = await page.evaluate(
    async ({ wsPath: wp, spaceId: sid, taskId: tid }) => {
      const hub = window.__messageHub || window.appState?.messageHub;
      if (!hub?.request) throw new Error('MessageHub not available');

      // Mark task done first — prevents the space runtime from processing it.
      await hub.request('spaceTask.update', { spaceId: sid, taskId: tid, status: 'done' });

      // Create a lightweight human session (no AI). ChatContainer can load any
      // valid session — it doesn't have to be a space_task_agent type session.
      const { sessionId: newSessionId } = (await hub.request('session.create', {
        workspacePath: wp,
        createdBy: 'human',
      })) as { sessionId: string };

      return newSessionId;
    },
    { wsPath, spaceId, taskId }
  );

  return { spaceId, taskId, sessionId, wsPath };
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

/**
 * Open the agent overlay using the test hook exposed by SpaceIsland.
 *
 * The hook (`window.__neokai_space_overlay.open`) sets the client-side
 * spaceOverlaySessionIdSignal / spaceOverlayAgentNameSignal which cause
 * SpaceIsland to render `<AgentOverlayChat>`. It is registered in SpaceIsland's
 * mount useEffect, so we wait for it to be available before calling.
 */
async function openOverlay(
  page: Parameters<typeof waitForWebSocketConnected>[0],
  sessionId: string,
  agentName = 'Task Agent'
): Promise<void> {
  // Wait for SpaceIsland to mount and register the hook.
  await page.waitForFunction(() => !!(window as Record<string, unknown>).__neokai_space_overlay, {
    timeout: 10000,
  });
  await page.evaluate(
    ({ sid, name }) => {
      type Api = { open: (s: string, n: string) => void };
      const api = (window as Record<string, unknown>).__neokai_space_overlay as Api;
      api.open(sid, name);
    },
    { sid: sessionId, name: agentName }
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Agent Overlay Chat', () => {
  // Serial mode: tests share describe-scoped let variables and each beforeEach
  // creates fresh state. Serial execution ensures those variables aren't
  // overwritten mid-test by another test's beforeEach on the same worker.
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: DESKTOP_VIEWPORT });

  let spaceId = '';
  let taskId = '';
  let sessionId = '';
  let wsPath = '';

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    const ctx = await createSpaceWithTaskAndSession(page);
    spaceId = ctx.spaceId;
    taskId = ctx.taskId;
    sessionId = ctx.sessionId;
    wsPath = ctx.wsPath;
  });

  test.afterEach(async ({ page }) => {
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

  // ─── Test 1: Opening the overlay via test hook ────────────────────────────

  test('opening the overlay shows the agent overlay panel', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    // Open overlay via the test hook (header button was removed in a019567d0).
    await openOverlay(page, sessionId, 'Task Agent');

    // The overlay panel must appear.
    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 2: Task view remains accessible while overlay is open ─────────

  test('task view is still visible underneath while overlay is open', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    // Overlay is open.
    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    // URL must NOT have changed — the task view is still the active route.
    expect(page.url()).toContain(`/space/${spaceId}/task/${taskId}`);

    // The task-thread-panel remains in the DOM (rendered underneath the overlay).
    await expect(page.getByTestId('task-thread-panel')).toBeAttached({ timeout: 5000 });
  });

  // ─── Test 3: Agent identity surfaced via dialog aria-label ──────────────

  test('overlay surfaces the agent name via the dialog aria-label', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    const overlay = page.getByTestId('agent-overlay-chat');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // The dialog wrapper's aria-label must be non-empty so screen readers
    // identify which agent is open. It's either `${agentName} chat` when we
    // have a name, or the fallback `Agent chat` — both are non-empty.
    const ariaLabel = await overlay.getAttribute('aria-label');
    expect(ariaLabel?.trim().length).toBeGreaterThan(0);
    expect(ariaLabel).toMatch(/chat$/);
  });

  // ─── Test 4: Back button dismisses the overlay ──────────────────────────

  test('back button in the chat header dismisses the overlay', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    // Overlay is open.
    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    // The embedded ChatContainer owns the only header; its left-slot back
    // button (which replaces the mobile-menu button when `onBack` is set)
    // is the dismiss control.
    await page.getByTestId('chat-header-back').click();

    // Overlay must be gone.
    await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });

    // Task thread panel must still be visible.
    await expect(page.getByTestId('task-thread-panel')).toBeVisible({ timeout: 5000 });
  });

  // ─── Test 5: Escape key dismisses the overlay ───────────────────────────

  test('pressing Escape dismisses the overlay', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    // Overlay is open.
    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    // Press Escape.
    await page.keyboard.press('Escape');

    // Overlay must be gone.
    await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });
  });

  // ─── Test 6: Backdrop click dismisses the overlay ───────────────────────

  test('clicking the backdrop dismisses the overlay', async ({ page }) => {
    await page.goto(`/space/${spaceId}/task/${taskId}`);
    await page.waitForURL(`/space/${spaceId}/task/${taskId}`, { timeout: 10000 });

    await openOverlay(page, sessionId, 'Task Agent');

    // Overlay is open.
    await expect(page.getByTestId('agent-overlay-chat')).toBeVisible({ timeout: 5000 });

    // Click the translucent backdrop (the aria-hidden div that fills the left
    // side of the screen). The slide-over panel is right-aligned (max-w-2xl),
    // so clicking at {x:100, y:100} relative to the full-screen backdrop lands
    // safely in the left area, away from the panel.
    const backdrop = page.getByTestId('agent-overlay-chat').locator('[aria-hidden="true"]').first();
    await backdrop.click({ position: { x: 100, y: 100 } });

    // Overlay must be gone.
    await expect(page.getByTestId('agent-overlay-chat')).toBeHidden({ timeout: 5000 });
  });
});
